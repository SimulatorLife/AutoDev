/**
 * The OpenLIT + ClickHouse Usage stack, and the readiness the supervised
 * Console needs before it serves.
 *
 * The Console's launcher refuses to serve a Runtime or Usage backend that
 * cannot satisfy the checked-out contracts, so every path that starts the
 * Console -- the development server and the installer alike -- has to bring
 * this stack up first. This module is that owner: one implementation of "the
 * Usage stack is up and serving", used by both.
 *
 * Readiness alone is not freshness: a healthy container may still be running
 * an older image or a stale bind-mounted configuration. The canonical runner
 * (`scripts/openlit/up.sh`) reuses an unchanged image, lets Compose recreate
 * only the services whose image or configuration fingerprint changed,
 * preserves the durable volumes, and verifies the deployed Usage v5 response
 * contract before it exits. A runner failure is therefore a failure of the
 * stack, not of the caller that invoked it.
 */

import { spawnSync } from "node:child_process";
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

/** Whether something is listening on a loopback port. */
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

/** Injectable process boundary for the Usage stack lifecycle. */
export interface UsageStackDependencies {
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: UsageStackCommandOptions
  ) => UsageStackCommandResult;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly isOpenlitHttpReady: () => Promise<boolean>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
  /** The environment the canonical runner is invoked with. */
  readonly runnerEnv: NodeJS.ProcessEnv;
}

export interface UsageStackOptions {
  readonly repositoryRoot: string;
  readonly platform: NodeJS.Platform;
  /** The prefix of this path's progress lines, e.g. `dev` or `install`. */
  readonly label: string;
}

function runUsageCommand(
  command: string,
  args: readonly string[],
  options: UsageStackCommandOptions
): UsageStackCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    stdio: options.stdio,
    timeout: options.timeoutMs,
    env: options.env
  });
  return { status: result.status, error: result.error };
}

function defaultDependencies(): UsageStackDependencies {
  return {
    runCommand: runUsageCommand,
    isPortListening: (port) => isPortListening(port),
    isOpenlitHttpReady: httpHealthProbe(`http://127.0.0.1:${OPENLIT_PORT}`, {
      cache: "no-store"
    }),
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
    timeoutMs: 10_000
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
 * Bring the Usage stack up and prove it is serving.
 *
 * The runner owns the whole lifecycle -- the image, the secrets, the Compose
 * reconciliation, the readiness wait, the Collector's schema, and the
 * deployed Usage v5 response contract -- so this is one call to it and a
 * readiness wait. A failure names the stack, because the caller that
 * invoked it cannot know more than the runner reported.
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
  const started = dependencies.runCommand(
    "bash",
    [path.join(options.repositoryRoot, "scripts", "openlit", "up.sh")],
    {
      cwd: options.repositoryRoot,
      stdio: "inherit",
      env: dependencies.runnerEnv
    }
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
