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

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { SERVICE_TEMPORARY_FAILURE_EXIT_CODE } from "@simulatorlife/autodev-runtime/shared/service-lifecycle";

import { buildConsole } from "./console-build.ts";
import {
  LABEL_AUTODEV_CONSOLE as CONSOLE_SERVICE_LABEL,
  resolveConsolePort
} from "./console-ensure.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { resolveCommandOnPath } from "./runtime-files.ts";
import { sleep } from "./sleep.ts";
import { ensureUsageStack } from "./usage-stack.ts";

const WHITESPACE_SPLIT_PATTERN = /\s+/u;
const PID_NUMERIC_PATTERN = /^\d+$/u;
const AUTH_TOKEN_PATTERN =
  /<key>CODEX_HOME<\/key>\s*<string>([^<]+)<\/string>/u;
const JOB_PID_PATTERN = /^\tpid = (\d+)$/mu;
const JOB_LAST_EXIT_PATTERN = /^\tlast exit code = (\d+)/mu;
const JOB_STDERR_PATTERN = /^\tstderr path = (.+)$/mu;
const LINE_SPLIT_PATTERN = /\r?\n/u;
/**
`lsof -Fn` prefixes each field's value with its field name.
*/
const LSOF_NAME_PREFIX = "n";

export const LABEL_MODEL_ROUTER = "com.codex.model-router";
export const LABEL_OPENCLI_PROXY = "com.codex.opencli-proxy";
export const MANAGED_SERVICE_LABELS = [
  LABEL_MODEL_ROUTER,
  LABEL_OPENCLI_PROXY,
  CONSOLE_SERVICE_LABEL
] as const;
export type ManagedServiceLabel = (typeof MANAGED_SERVICE_LABELS)[number];
export type KillSignal = "SIGTERM" | "SIGKILL";

interface ManagedServicePaths {
  readonly launcher: string;
  readonly root: "repository" | "codex";
  readonly executable: readonly string[];
}

const SERVICE_PATHS = {
  [CONSOLE_SERVICE_LABEL]: {
    launcher: "run-autodev-console.sh",
    root: "repository",
    executable: ["console", "node_modules", "next", "dist", "bin", "next"]
  },
  [LABEL_MODEL_ROUTER]: {
    launcher: "run-autodev-model-router.sh",
    root: "codex",
    executable: ["src", "router", "server.ts"]
  },
  [LABEL_OPENCLI_PROXY]: {
    launcher: "run-autodev-opencli-proxy.sh",
    root: "codex",
    executable: ["src", "providers", "opencli.ts"]
  }
} satisfies Readonly<Record<ManagedServiceLabel, ManagedServicePaths>>;

export interface ServiceRestartOptions {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly codexHome: string;
  readonly consolePort: number;
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
  readonly fileSize?: ((filePath: string) => number | null) | undefined;
  readonly logTail: (
    filePath: string,
    lines: number,
    afterByte?: number
  ) => readonly string[];
  readonly commandAvailable: (command: string) => boolean;
  readonly buildConsole: () => void;
  /**
  GET the URL, or POST `jsonBody` as JSON when one is given.
  */
  readonly probe: (url: string, jsonBody?: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly run: (
    command: string,
    arguments_: readonly string[],
    input?: string,
    environment?: NodeJS.ProcessEnv
  ) => number;
  readonly listeningPids: (port: number) => readonly number[] | null;
  readonly commandLine: (pid: number) => string | null;
  /**
  The process's current working directory, when it can be read.
  */
  readonly workingDirectory: (pid: number) => string | null;
  readonly kill: (pid: number, signal: KillSignal) => void;
  /**
  Bring the Usage stack up and prove it is serving.
  
  The Console's launcher refuses to serve a Usage backend that cannot
  satisfy the checked-out contract, so the stack has to be serving before
  the Console's job is bootstrapped -- otherwise the launcher exits before
  it ever execs Next.js and the job crash-loops on a backend that was
  merely starting.
  */
  readonly ensureUsageStack: () => Promise<boolean>;
}

/**
The supervised Console answers only after Next.js has booted, which takes
tens of seconds on a loaded machine, and it starts booting only once the
Model Router's Control API answers. The readiness budget therefore has to
cover the slowest supervised service's own startup: a shorter budget makes
the installer report a failed restart for a service that is about to come
up, while the service itself keeps starting.
*/
const DEFAULT_ATTEMPTS = 400;
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
  /**
  Only set where the launcher execs the server, so the job pid is the listener.
  */
  readonly ownedPort: number | null;
  readonly required: boolean;
}

const SERVICE_PORTS = {
  [LABEL_MODEL_ROUTER]: 4100,
  [LABEL_OPENCLI_PROXY]: 4004
} as const satisfies Record<
  Exclude<ManagedServiceLabel, typeof CONSOLE_SERVICE_LABEL>,
  number
>;

function servicePort(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): number {
  return label === CONSOLE_SERVICE_LABEL
    ? options.consolePort
    : SERVICE_PORTS[label];
}

function serviceSpecs(options: ServiceRestartOptions): readonly ServiceSpec[] {
  return [
    {
      label: CONSOLE_SERVICE_LABEL,
      probe: `http://127.0.0.1:${options.consolePort}/api/health`,
      ownedPort: options.consolePort,
      required: true
    },
    {
      label: LABEL_MODEL_ROUTER,
      probe: "http://127.0.0.1:4100/health/readiness",
      ownedPort: SERVICE_PORTS[LABEL_MODEL_ROUTER],
      required: true
    },
    {
      label: LABEL_OPENCLI_PROXY,
      probe: "http://127.0.0.1:4004/health/liveliness",
      ownedPort: SERVICE_PORTS[LABEL_OPENCLI_PROXY],
      required: false
    }
  ];
}

/**
Which service has to be serving before another one may be reloaded.

The Console reads the Model Router's private Control API when it starts and
refuses to serve traffic without it, so the Router has to be answering
before the Console's job is bootstrapped. Reloading the two back to back
races that dependency: the Console starts while the Router is still
binding its ports, spends its own startup budget waiting, exits, and only
comes back after launchd's throttle interval — long after the installer's
readiness budget is gone, so the install reports a failure for a stack that
is in fact healthy.
*/
const SERVICE_DEPENDENCIES: Partial<
  Record<ManagedServiceLabel, ManagedServiceLabel>
> = {
  [CONSOLE_SERVICE_LABEL]: LABEL_MODEL_ROUTER
};

export function resolveServiceRestartOptions(
  environment: NodeJS.ProcessEnv = process.env
): ServiceRestartOptions {
  const home = environment.HOME?.trim() || homedir();
  return {
    repositoryRoot: environment.AUTODEV_REPO_ROOT?.trim() || process.cwd(),
    home,
    codexHome: environment.CODEX_HOME?.trim() || path.join(home, ".codex"),
    consolePort: resolveConsolePort(environment.AUTODEV_CONSOLE_PORT),
    readyAttempts: parseNonNegativeInteger(
      environment.AUTODEV_SERVICE_READY_ATTEMPTS,
      DEFAULT_ATTEMPTS
    ),
    readyDelayMs: parseNonNegativeInteger(
      environment.AUTODEV_SERVICE_READY_DELAY_MS,
      DEFAULT_DELAY_MS
    )
  };
}

const PLIST_STDERR_PATTERN =
  /<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/u;

function readPlistStderrPath(
  dependencies: ServiceRestartDeps,
  plistFilePath: string
): string | null {
  const content = dependencies.readFile(plistFilePath);
  const match = PLIST_STDERR_PATTERN.exec(content);
  return match?.[1]?.trim() || null;
}

function readLogTail(
  filePath: string,
  lines: number,
  afterByte?: number
): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(filePath).size;
    const minOffset =
      afterByte !== undefined && afterByte >= 0 && afterByte <= size
        ? afterByte
        : 0;
    const startOffset = Math.max(minOffset, size - LOG_TAIL_BYTES);
    const length = size - startOffset;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    fd = openSync(filePath, "r");
    readSync(fd, buffer, 0, length, startOffset);
    return buffer
      .toString("utf8")
      .split(LINE_SPLIT_PATTERN)
      .filter((line) => line.trim().length > 0)
      .slice(-lines);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function defaultDependencies(options: ServiceRestartOptions): ServiceRestartDeps {
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
    fileSize: (filePath) => {
      try {
        return statSync(filePath).size;
      } catch {
        return null;
      }
    },
    logTail: readLogTail,
    commandAvailable: (command) => resolveCommandOnPath(command) !== null,
    buildConsole: () =>
      buildConsole({ repositoryRoot: options.repositoryRoot }),
    probe: async (url, jsonBody) => {
      try {
        const response = await fetch(url, {
          ...(jsonBody !== undefined && {
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
    sleep,
    run: (command, arguments_, input, environment) => {
      const stdio: "inherit" | ["pipe", "inherit", "inherit"] =
        input === undefined ? "inherit" : ["pipe", "inherit", "inherit"];
      return (
        spawnSync(command, [...arguments_], {
          input,
          env: { ...process.env, ...environment },
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
      } catch (error) {
        const failure = error as {
          status?: number | null;
          stdout?: Buffer | string;
          stderr?: Buffer | string;
        };
        if (
          failure.status === 1 &&
          !String(failure.stdout ?? "").trim() &&
          !String(failure.stderr ?? "").trim()
        ) {
          return [];
        }
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
    workingDirectory: (pid) => {
      try {
        const output = execFileSync(
          "lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        const name = output
          .split(LINE_SPLIT_PATTERN)
          .find((line) => line.startsWith(LSOF_NAME_PREFIX));
        return name ? name.slice(LSOF_NAME_PREFIX.length) : null;
      } catch {
        return null;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /*
        process exited
        */
      }
    },
    ensureUsageStack: async () => {
      try {
        await ensureUsageStack({
          repositoryRoot: options.repositoryRoot,
          platform: process.platform,
          label: "install"
        });
        return true;
      } catch (error) {
        writeErrorLine(
          `the OpenLIT and ClickHouse Usage services are not serving: ${errorText(error)}`
        );
        return false;
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

function servicePaths(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): { readonly launcher: string; readonly hook: string } {
  const service = SERVICE_PATHS[label];
  if (!service) throw new Error(`unknown managed service label: ${label}`);
  const root =
    service.root === "repository" ? options.repositoryRoot : options.codexHome;
  return {
    launcher: path.join(options.codexHome, "hooks", service.launcher),
    hook: path.join(root, ...service.executable)
  };
}

interface ServiceOwnership {
  /**
  Path fragments that identify the process in its command line.
  */
  readonly commandLinePaths: readonly string[];
  /**
  The directory the service runs in, when it pins one.
  */
  readonly workingDirectory: string | null;
}

/**
How a port holder is recognized as a process this runtime runs for a
label.

The Console matches its whole installation root rather than the launcher's
entry script alone: a dev session reaches Next.js through pnpm's bin shim
(`console/node_modules/.bin/../..`), so the launcher's exact path never
appears in its command line, and the Console would then look foreign to
every reaper and refuse to converge.
*/
function serviceOwnership(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): ServiceOwnership {
  if (label === CONSOLE_SERVICE_LABEL)
    return {
      commandLinePaths: [
        path.join(options.repositoryRoot, "console", "node_modules") + path.sep
      ],
      // The Console runs from the repository's console directory whether its
      // launchd job started it or a dev session did.
      workingDirectory: path.join(options.repositoryRoot, "console")
    };
  return {
    commandLinePaths: [servicePaths(options, label).hook],
    workingDirectory: null
  };
}

/**
Whether a port holder is a process this runtime runs for the label.

The command line is the primary signal, but the process list is not
readable in every environment (sandboxes deny `ps`), so a service that
pins a working directory is recognized by that too. A holder that matches
neither signal belongs to someone else and is never stopped.
*/
function isOwnedServiceProcess(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  pid: number,
  dependencies: ServiceRestartDeps
): boolean {
  const ownership = serviceOwnership(options, label);
  const commandLine = dependencies.commandLine(pid);
  if (
    commandLine &&
    ownership.commandLinePaths.some((ownedPath) =>
      commandLine.includes(ownedPath)
    )
  )
    return true;
  if (ownership.workingDirectory === null) return false;
  return dependencies.workingDirectory(pid) === ownership.workingDirectory;
}

function plistOwner(
  options: ServiceRestartOptions,
  dependencies: ServiceRestartDeps
): string | null {
  const filePath = plistPath(options, LABEL_MODEL_ROUTER);
  if (!dependencies.fileExists(filePath)) return null;
  const match = AUTH_TOKEN_PATTERN.exec(dependencies.readFile(filePath));
  return match?.[1] ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error);
}

async function waitForPortRelease(
  dependencies: ServiceRestartDeps,
  port: number,
  pid: number,
  attempts: number
): Promise<boolean> {
  if (!(dependencies.listeningPids(port) ?? []).includes(pid)) return true;
  if (attempts <= 0) return false;
  await dependencies.sleep(REAP_DELAY_MS);
  return waitForPortRelease(dependencies, port, pid, attempts - 1);
}

/**
Stop a process this CODEX_HOME's hook runs outside launchd, and wait until
it has let go of the port: bootstrapping while it still listens starts a
KeepAlive EADDRINUSE crash loop.
*/
async function reapUnmanaged(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  dependencies: ServiceRestartDeps,
  pids: readonly number[] = dependencies.listeningPids(servicePort(options, label)) ??
    []
): Promise<boolean> {
  const [pid, ...rest] = pids;
  if (pid === undefined) return true;
  const port = servicePort(options, label);
  if (!isOwnedServiceProcess(options, label, pid, dependencies)) {
    writeErrorLine(
      `port ${port} held by a process this installer does not own (pid ${pid}); ${label} not started`
    );
    return false;
  }
  writeErrorLine(`reaping unmanaged ${label} on port ${port} (pid ${pid})`);
  dependencies.kill(pid, "SIGTERM");
  if (!(await waitForPortRelease(dependencies, port, pid, REAP_TERM_ATTEMPTS))) {
    dependencies.kill(pid, "SIGKILL");
    if (!(await waitForPortRelease(dependencies, port, pid, REAP_KILL_ATTEMPTS))) {
      writeErrorLine(
        `pid ${pid} still holds port ${port}; ${label} not started`
      );
      return false;
    }
  }
  return reapUnmanaged(options, label, dependencies, rest);
}

async function runDirectEnsures(
  options: ServiceRestartOptions,
  dependencies: ServiceRestartDeps
): Promise<number> {
  await Promise.resolve();
  const run = (
    script: string,
    input?: string,
    environment?: NodeJS.ProcessEnv
  ): number => dependencies.run("/bin/bash", [script], input, environment);
  if (
    run(
      path.join(
        options.repositoryRoot,
        "scripts",
        "ensure-autodev-model-router.sh"
      )
    ) !== 0
  )
    return 1;
  if (
    run(
      path.join(
        options.repositoryRoot,
        "scripts",
        "ensure-autodev-opencli-proxy.sh"
      )
    ) !== 0
  )
    writeErrorLine(
      "bridge start failed: ensure-autodev-opencli-proxy.sh (router will route around it)"
    );
  return 0;
}

function isOwnedService(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  jobDump: string
): boolean {
  if (jobDump.includes(servicePaths(options, label).launcher)) return true;
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

// Probing is an in-process HTTP request, but reading a job's state spawns
// `launchctl`: during an install, a steady stream of spawns measurably stalled
// the services' own launches (17s with a read every attempt against 7s with
// none), so the crash-loop check only runs every few attempts.
const JOB_STATE_EVERY_ATTEMPTS = 8;

/**
Why a job that never became ready is still trying.

A job that exits with the temporary-failure status is waiting for a
backend, and the report says so: the operator needs to know that the
service is not broken but late, and that the backend is what is missing.
*/
function retryingReason(job: JobState): string {
  if (job.lastExitCode !== SERVICE_TEMPORARY_FAILURE_EXIT_CODE) return "";
  return " (its last attempt stopped because a backend it reads did not answer)";
}

/**
A job that exited, and why it is not a crash loop.

A service that stops because a backend it reads has not come up yet exits
with the temporary-failure status, and launchd restarts it -- the job is on
its way up, not broken. Any exit with status 0 or another non-zero code in a
KeepAlive service means the process stopped immediately instead of serving,
and waiting out the readiness budget on it only delays the report.
*/
function crashLoop(job: JobState): ServiceCheck | null {
  if ((job.lastExitCode === null) || (job.lastExitCode === SERVICE_TEMPORARY_FAILURE_EXIT_CODE)) return null;
  return {
    ready: false,
    reason:
      job.lastExitCode === 0
        ? "exited immediately with code 0 instead of staying up"
        : `exited with code ${job.lastExitCode}`,
    stderrPath: job.stderrPath
  };
}

function confirmOwner(
  dependencies: ServiceRestartDeps,
  spec: ServiceSpec
): ServiceCheck {
  if (spec.ownedPort === null) return { ready: true };
  const job = parseJobState(readLaunchdJobDump(dependencies, spec.label));
  const listeners = dependencies.listeningPids(spec.ownedPort) ?? [];
  if (job.pid !== null && listeners.includes(job.pid)) return { ready: true };
  return {
    ready: false,
    reason: `port ${spec.ownedPort} is served by pid ${listeners.join(", ") || "unknown"}, not the launchd job (pid ${job.pid ?? "none"})`,
    stderrPath: job.stderrPath
  };
}

/**
A freshly bootstrapped job has never exited, so any recorded exit code means
it is crash-looping under KeepAlive: report that as soon as it is seen
instead of waiting out the readiness budget on a process that will never
answer.
*/
async function checkService(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions,
  spec: ServiceSpec,
  attempt = 0
): Promise<ServiceCheck> {
  if (await dependencies.probe(spec.probe, spec.jsonBody))
    return confirmOwner(dependencies, spec);
  const isLastAttempt = attempt + 1 >= options.readyAttempts;
  if (attempt % JOB_STATE_EVERY_ATTEMPTS === 0 || isLastAttempt) {
    const job = parseJobState(readLaunchdJobDump(dependencies, spec.label));
    const crashed = crashLoop(job);
    if (crashed) return crashed;
    if (isLastAttempt)
      return {
        ready: false,
        reason: `did not become ready within ${options.readyAttempts * options.readyDelayMs}ms${retryingReason(job)}`,
        stderrPath: job.stderrPath
      };
  }
  await dependencies.sleep(options.readyDelayMs);
  return checkService(dependencies, options, spec, attempt + 1);
}

/**
Confirm every supervised service is up and owned by its launchd job.
*/
async function verifySupervisedServices(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions,
  logOffsets: ReadonlyMap<ManagedServiceLabel, number> = new Map()
): Promise<number> {
  const specs = serviceSpecs(options);
  const checks = await Promise.all(
    specs.map((spec) => checkService(dependencies, options, spec))
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
      const afterByte = logOffsets.get(spec.label);
      const lines = dependencies.logTail(
        check.stderrPath,
        FAILURE_LOG_LINES,
        afterByte
      );
      if (lines.length === 0 && afterByte !== undefined) {
        writeErrorLine("  | (no new log output since reload)");
      } else {
        for (const line of lines) writeErrorLine(`  | ${line}`);
      }
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
  dependencies: ServiceRestartDeps,
  label: ManagedServiceLabel
): string {
  try {
    return dependencies.launchd.print(label);
  } catch {
    /*
    treat as unavailable
    */
  }
  return "";
}

type ReloadResult = "ok" | "no-plist" | "failed" | "blocked" | "build-failed";

function foreignLabels(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions
): ManagedServiceLabel[] {
  return MANAGED_SERVICE_LABELS.filter(
    (label) =>
      dependencies.launchd.isLoaded(label) &&
      !isOwnedService(options, label, readLaunchdJobDump(dependencies, label))
  );
}

/**
The production build is published over the console port, so that port has
to belong to this runtime: free, held by the managed LaunchAgent, or held
by a Console process this runtime owns — a previous install's console, or
a dev session — which the reload path stops before it bootstraps the
managed job. A holder this runtime does not own is a hard stop, because
neither the build nor the restart may take its port.
*/
function consolePortIsSafeToPublish(
  options: ServiceRestartOptions,
  dependencies: ServiceRestartDeps
): boolean {
  const listeners = dependencies.listeningPids(options.consolePort);
  if (listeners === null) {
    writeErrorLine(
      `could not verify Console port ${options.consolePort}; refusing to replace its production build.`
    );
    return false;
  }
  if (listeners.length === 0) return true;

  if (dependencies.launchd.isLoaded(CONSOLE_SERVICE_LABEL)) {
    const job = parseJobState(readLaunchdJobDump(dependencies, CONSOLE_SERVICE_LABEL));
    const foreign = listeners.filter(
      (pid) =>
        pid !== job.pid &&
        !isOwnedServiceProcess(options, CONSOLE_SERVICE_LABEL, pid, dependencies)
    );
    if (foreign.length > 0) {
      writeErrorLine(
        `Console port ${options.consolePort} is not owned by its managed LaunchAgent; refusing to replace the build.`
      );
      return false;
    }
    return true;
  }

  const foreign = listeners.filter(
    (pid) => !isOwnedServiceProcess(options, CONSOLE_SERVICE_LABEL, pid, dependencies)
  );
  if (foreign.length > 0) {
    writeErrorLine(
      `Console port ${options.consolePort} is held by pid ${foreign.join(", ")} outside this AutoDev Console; refusing to replace the build. Stop it, or set AUTODEV_CONSOLE_PORT to a free port.`
    );
    return false;
  }
  return true;
}

/**
Replace a label's job: unload the old one, clear stray listeners, then
bootstrap. Every managed plist sets RunAtLoad, so bootstrap starts the
service; a following `kickstart -k` would kill that fresh instance
mid-startup and stall for launchd's ThrottleInterval before respawning it.
*/
async function reloadOneLabel(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  logOffsets?: Map<ManagedServiceLabel, number>
): Promise<ReloadResult> {
  const plist = plistPath(options, label);
  if (!dependencies.fileExists(plist)) return "no-plist";
  try {
    dependencies.launchd.bootout(label);
  } catch (error) {
    writeErrorLine(`could not unload ${label}: ${errorText(error)}`);
    return "failed";
  }
  if (!(await reapUnmanaged(options, label, dependencies))) return "failed";
  if (logOffsets && dependencies.fileSize) {
    const stderrPath = readPlistStderrPath(dependencies, plist);
    if (stderrPath) {
      const size = dependencies.fileSize(stderrPath);
      logOffsets.set(label, size ?? 0);
    }
  }
  try {
    dependencies.launchd.enable(label);
    dependencies.launchd.bootstrap(plist);
    return "ok";
  } catch (error) {
    writeErrorLine(`could not load ${label}: ${errorText(error)}`);
    return "failed";
  }
}

/**
Wait for the service another one depends on to be serving, so a dependent
is never bootstrapped against an API that is not there yet.

The Console has two dependencies. The Model Router serves the Control API
the Console reads, and the OpenLIT + ClickHouse stack serves the Usage
contract the Console's launcher verifies before it serves a single page.
Both are checked here, because a dependency that is not there yet is a
reason to wait, not a reason to start the dependent and let it fail.
*/
async function awaitDependency(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): Promise<ServiceCheck> {
  if (label === CONSOLE_SERVICE_LABEL && !(await dependencies.ensureUsageStack())) {
    return {
      ready: false,
      reason: "the OpenLIT and ClickHouse Usage services are not serving",
      stderrPath: null
    };
  }
  const dependency = SERVICE_DEPENDENCIES[label];
  if (dependency === undefined) return { ready: true };
  const spec = serviceSpecs(options).find(
    (candidate) => candidate.label === dependency
  );
  if (spec === undefined) return { ready: true };
  const check = await checkService(dependencies, options, spec);
  if (!check.ready) {
    writeErrorLine(
      `${dependency} is not running: ${check.reason}; ${label} was not reloaded because it reads the Model Router's Control API`
    );
  }
  return check;
}

function ensureConsoleBuildBeforeLaunch(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions
): boolean {
  const buildIdPath = path.join(
    options.repositoryRoot,
    "console",
    ".next",
    "BUILD_ID"
  );
  if (dependencies.fileExists(buildIdPath)) return true;
  writeErrorLine(
    `Console build artifact missing at ${buildIdPath}; building staged Console artifact before launch.`
  );
  try {
    dependencies.buildConsole();
  } catch (error) {
    writeErrorLine(
      `Console production build failed before launch: ${errorText(error)}`
    );
    return false;
  }
  if (!dependencies.fileExists(buildIdPath)) {
    writeErrorLine(
      `Console build completed without producing ${buildIdPath}; ${CONSOLE_SERVICE_LABEL} was not reloaded.`
    );
    return false;
  }
  return true;
}

async function reloadLabels(
  dependencies: ServiceRestartDeps,
  options: ServiceRestartOptions,
  index = 0,
  results: ReloadResult[] = [],
  logOffsets?: Map<ManagedServiceLabel, number>
): Promise<ReloadResult[]> {
  const label = MANAGED_SERVICE_LABELS[index];
  if (label === undefined) return results;
  const dependency = await awaitDependency(dependencies, options, label);
  if (!dependency.ready) {
    writeErrorLine(`${label} was not reloaded: ${dependency.reason}.`);
    results.push("blocked");
    return results;
  }
  if (
    label === CONSOLE_SERVICE_LABEL &&
    !ensureConsoleBuildBeforeLaunch(dependencies, options)
  ) {
    results.push("build-failed");
    return results;
  }
  results.push(await reloadOneLabel(dependencies, options, label, logOffsets));
  return reloadLabels(dependencies, options, index + 1, results, logOffsets);
}

export async function restartServices(
  options: ServiceRestartOptions = resolveServiceRestartOptions(),
  dependencies: ServiceRestartDeps = defaultDependencies(options)
): Promise<number> {
  const owner = plistOwner(options, dependencies);
  const foreignOwnerResult = foreignOwnedHookResult(options, owner);
  if (foreignOwnerResult !== null) return foreignOwnerResult;

  if (!dependencies.commandAvailable("launchctl")) {
    writeErrorLine(
      "launchctl unavailable (sandbox?); starting bridges through the direct ensure-hook path."
    );
    const status = await runDirectEnsures(options, dependencies);
    if (status !== 0) return status;
    writeErrorLine(
      "the Console service cannot be safely restarted without launchd; start its managed LaunchAgent before serving traffic."
    );
    return 1;
  }
  const foreign = foreignLabels(dependencies, options);
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
  const consolePlist = plistPath(options, CONSOLE_SERVICE_LABEL);
  const consoleLauncher = servicePaths(options, CONSOLE_SERVICE_LABEL).launcher;
  if (!dependencies.fileExists(consolePlist) || !dependencies.fileExists(consoleLauncher)) {
    writeErrorLine(
      "the managed Console LaunchAgent and launcher must be materialized before publishing a production build."
    );
    return 1;
  }
  if (!consolePortIsSafeToPublish(options, dependencies)) return 1;
  try {
    dependencies.buildConsole();
  } catch (error) {
    writeErrorLine(
      `Console production build failed; the currently served build was preserved: ${errorText(error)}`
    );
    return 1;
  }
  const logOffsets = new Map<ManagedServiceLabel, number>();
  const results = await reloadLabels(dependencies, options, 0, [], logOffsets);
  if (results.includes("build-failed")) return 1;
  const blockedLabels = MANAGED_SERVICE_LABELS.filter(
    (_label, index) => results[index] === "blocked"
  );
  if (blockedLabels.length > 0) {
    writeErrorLine(
      `${blockedLabels.join(", ")} was not reloaded because a service it depends on is not serving.`
    );
    return 1;
  }
  const failedLabels = MANAGED_SERVICE_LABELS.filter(
    (_label, index) => results[index] === "failed"
  );
  if (failedLabels.length > 0) {
    writeErrorLine(
      `launchd could not load ${failedLabels.join(", ")}; starting bridges through the direct ensure-hook path.`
    );
    const status = await runDirectEnsures(options, dependencies);
    if (status !== 0) return status;
    if (failedLabels.includes(CONSOLE_SERVICE_LABEL)) return 1;
    return status;
  }
  writeErrorLine(
    "Runtime services supervised by launchd (KeepAlive; survive restart/crash/sleep)."
  );
  return verifySupervisedServices(dependencies, options, logOffsets);
}

if (isEntryPoint(import.meta.url)) {
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
