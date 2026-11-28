/**
The OpenLIT + ClickHouse Usage stack, and the readiness the supervised
Console needs before it serves.

The Console's launcher refuses to serve a Runtime or Usage backend that
cannot satisfy the checked-out contracts, so every path that starts the
Console -- the development server and the installer alike -- has to bring
this stack up first. This module is that owner: one implementation of "the
Usage stack is up and serving", used by both.

Readiness alone is not freshness: a healthy container may still be running
an older image or a stale bind-mounted configuration. The canonical runner
(`scripts/openlit/up.sh`) reuses an unchanged image, lets Compose recreate
only the services whose image or configuration fingerprint changed,
preserves the durable volumes, and verifies the deployed Usage v5 response
contract before it exits. A runner failure is therefore a failure of the
stack, not of the caller that invoked it.
*/

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";

import { writeLine } from "@simulatorlife/autodev-runtime/shared/output";

import { httpHealthProbe } from "./health-probe.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

const OPENLIT_PORT = 3000;
const CLICKHOUSE_HTTP_PORT = 8123;
const DOCKER_READY_TIMEOUT_MS = 120_000;
const STACK_READY_TIMEOUT_MS = 120_000;
const DOCKER_PROBE_TIMEOUT_MS = 5000;

/**
Whether something is listening on a loopback port.
*/
/**
OpenLIT's HTTP readiness probe. Its root answers with a redirect to
`/dashboard`, which the shared health probe refuses by design, so the probe
asks for the page that is actually served.
*/
export const openlitHttpReady = httpHealthProbe(
  `http://127.0.0.1:${OPENLIT_PORT}/dashboard`,
  { cache: "no-store" }
);

export function isPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 400
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface UsageStackCommandOptions {
  readonly cwd: string;
  readonly stdio: "ignore" | "inherit";
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface UsageStackCommandResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

/**
Injectable process boundary for the Usage stack lifecycle.
*/
export interface UsageStackDependencies {
  readonly runCommand: (
    command: string,
    arguments_: readonly string[],
    options: UsageStackCommandOptions
  ) => UsageStackCommandResult;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly isOpenlitHttpReady: () => Promise<boolean>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
  /**
  The environment the canonical runner is invoked with.
  */
  readonly runnerEnv: NodeJS.ProcessEnv;
}

export interface UsageStackOptions {
  readonly repositoryRoot: string;
  readonly platform: NodeJS.Platform;
  /**
  The prefix of this path's progress lines, e.g. `dev` or `install`.
  */
  readonly label: string;
}

function runUsageCommand(
  command: string,
  arguments_: readonly string[],
  options: UsageStackCommandOptions
): UsageStackCommandResult {
  const result = spawnSync(command, [...arguments_], {
    cwd: options.cwd,
    stdio: options.stdio,
    timeout: options.timeoutMs,
    env: options.env
  });
  return { status: result.status, error: result.error };
}

function runUsageCommandAsync(
  command: string,
  arguments_: readonly string[],
  options: UsageStackCommandOptions
): Promise<UsageStackCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...arguments_], {
      cwd: options.cwd,
      stdio: options.stdio,
      env: options.env
    });
    let isSettled = false;
    const finish = (result: UsageStackCommandResult): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill("SIGTERM");
            finish({ status: null, error: new Error("command timed out") });
          }, options.timeoutMs);
    timer?.unref();
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status) => finish({ status }));
  });
}

function defaultDependencies(): UsageStackDependencies {
  return {
    runCommand: runUsageCommand,
    isPortListening: (port) => isPortListening(port),
    isOpenlitHttpReady: openlitHttpReady,
    sleep,
    writeLine,
    runnerEnv: { ...process.env }
  };
}

function commandSucceeded(result: UsageStackCommandResult): boolean {
  return result.error === undefined && result.status === 0;
}

function dockerInfo(
  dependencies: UsageStackDependencies,
  options: UsageStackOptions
): boolean {
  return commandSucceeded(
    dependencies.runCommand("docker", ["info"], {
      cwd: options.repositoryRoot,
      stdio: "ignore",
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS
    })
  );
}

function waitForDockerEngine(
  dependencies: UsageStackDependencies,
  options: UsageStackOptions
): Promise<boolean> {
  return waitForProbe(
    {
      probe: () => Promise.resolve(dockerInfo(dependencies, options)),
      sleep: dependencies.sleep
    },
    DOCKER_READY_TIMEOUT_MS
  );
}

/**
launchd's default search path for processes in the user's login session.
*/
const LOGIN_SESSION_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
The environment Docker Desktop is launched with.

`open` hands its whole environment to the application it launches
("Opened applications inherit environment variables just as if you had
launched the application directly", open(1)). The caller's environment is
a toolchain environment -- pnpm lifecycle variables, Node and Electron
options, AutoDev secrets such as the Usage service token. Launched with
it, Docker Desktop's backend fails to start its Electron UI ("starting
electron: unmarshaling start request: unexpected EOF") and shuts itself
down, so the Engine never comes up -- while the same app opened from Finder
starts normally. Docker Desktop is therefore launched the way Finder
launches it: with only the login-session identity, never the caller's
environment.
*/
export function desktopLaunchEnvironment(
  callerEnvironment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: LOGIN_SESSION_PATH };
  for (const name of ["HOME", "USER", "LOGNAME"] as const) {
    const value = callerEnvironment[name];
    if (value) environment[name] = value;
  }
  return environment;
}

async function ensureDockerEngine(
  dependencies: UsageStackDependencies,
  options: UsageStackOptions
): Promise<void> {
  if (dockerInfo(dependencies, options)) return;
  if (options.platform !== "darwin") {
    throw new Error(
      "Docker Engine is required for OpenLIT Usage. Start Docker, then rerun this command."
    );
  }

  dependencies.writeLine(
    `[${options.label}] Docker Engine is unavailable; starting Docker Desktop...`
  );
  const launched = dependencies.runCommand("open", ["-a", "Docker"], {
    cwd: options.repositoryRoot,
    stdio: "ignore",
    timeoutMs: 10_000,
    env: desktopLaunchEnvironment(dependencies.runnerEnv)
  });
  if (!commandSucceeded(launched)) {
    throw new Error(
      "Docker Desktop could not be launched. Install or start Docker Desktop, then rerun this command."
    );
  }
  if (!(await waitForDockerEngine(dependencies, options))) {
    throw new Error(
      "Docker Desktop did not make Docker Engine ready within 120 seconds. Check Docker Desktop, then rerun this command."
    );
  }
}

async function isStackReady(
  dependencies: UsageStackDependencies
): Promise<boolean> {
  const [clickhouseReady, openlitReady] = await Promise.all([
    dependencies.isPortListening(CLICKHOUSE_HTTP_PORT),
    dependencies.isOpenlitHttpReady()
  ]);
  return clickhouseReady && openlitReady;
}

/**
Bring the Usage stack up and prove it is serving.

The runner owns the whole lifecycle -- the image, the secrets, the Compose
reconciliation, the readiness wait, the Collector's schema, and the
deployed Usage v5 response contract -- so this is one call to it and a
readiness wait. A failure names the stack, because the caller that
invoked it cannot know more than the runner reported.
*/
export async function ensureUsageStack(
  options: UsageStackOptions,
  overrides: Partial<UsageStackDependencies> = {}
): Promise<void> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  await ensureDockerEngine(dependencies, options);

  dependencies.writeLine(
    `[${options.label}] Reconciling the OpenLIT and ClickHouse Usage services...`
  );
  const upOptions: UsageStackCommandOptions = {
    cwd: options.repositoryRoot,
    stdio: "inherit",
    env: dependencies.runnerEnv
  };
  const started =
    overrides.runCommand === undefined
      ? await runUsageCommandAsync(
          "bash",
          [path.join(options.repositoryRoot, "scripts", "openlit", "up.sh")],
          upOptions
        )
      : dependencies.runCommand(
          "bash",
          [path.join(options.repositoryRoot, "scripts", "openlit", "up.sh")],
          upOptions
        );
  if (!commandSucceeded(started)) {
    const detail = started.error?.message;
    throw new Error(
      detail
        ? `OpenLIT startup failed: ${detail}`
        : `OpenLIT startup failed with exit status ${String(started.status)}. The runner reported the cause above — an unresponsive Docker Engine and a stack that never became ready are different failures with different fixes.`
    );
  }

  const ready = await waitForProbe(
    {
      probe: () => isStackReady(dependencies),
      sleep: dependencies.sleep
    },
    STACK_READY_TIMEOUT_MS
  );
  if (!ready) {
    throw new Error(
      "OpenLIT or ClickHouse did not become ready within 120 seconds; check the Docker Compose logs and rerun this command."
    );
  }

  dependencies.writeLine(
    `[${options.label}] ✔ OpenLIT Usage v5 and ClickHouse are ready (ports ${OPENLIT_PORT}, ${CLICKHOUSE_HTTP_PORT}).`
  );
}
