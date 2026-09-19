import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

const WHITESPACE_SPLIT_PATTERN = /\s+/u;
const PID_NUMERIC_PATTERN = /^\d+$/u;
const AUTH_TOKEN_PATTERN = /<key>CODEX_HOME<\/key>\s*<string>([^<]+)<\/string>/u;

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
    "isLoaded" | "print" | "bootout" | "bootstrap" | "enable" | "kickstart"
  >;
  readonly fileExists: (filePath: string) => boolean;
  readonly readFile: (filePath: string) => string;
  readonly commandAvailable: (command: string) => boolean;
  readonly probe: (url: string, method?: "GET" | "POST") => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly run: (
    command: string,
    args: readonly string[],
    input?: string,
    env?: NodeJS.ProcessEnv
  ) => number;
  readonly listeningPids: (port: number) => readonly number[] | null;
  readonly commandLine: (pid: number) => string | null;
  readonly kill: (pid: number) => void;
}

const DEFAULT_ATTEMPTS = 80;
const DEFAULT_DELAY_MS = 250;
const SERVICE_PORTS = {
  [LABEL_MODEL_ROUTER]: 4100,
  [LABEL_CLAUDE_BRIDGE]: 4000,
  [LABEL_MINIMAX_PROXY]: 18_765,
  [LABEL_ANTIGRAVITY_PROXY]: 4002,
  [LABEL_COPILOT_PROXY]: 4003,
  [LABEL_OTEL_COLLECTOR]: 4318
} as const satisfies Record<ManagedServiceLabel, number>;

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
    commandAvailable: (command) => {
      try {
        execFileSync("which", [command], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    probe: async (url, method = "GET") => {
      try {
        const response = await fetch(url, {
          method,
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
    kill: (pid) => {
      try {
        process.kill(pid);
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

function serviceProbe(label: ManagedServiceLabel): string {
  if (label === LABEL_MODEL_ROUTER)
    return "http://127.0.0.1:4100/health/readiness";
  if (label === LABEL_CLAUDE_BRIDGE)
    return "http://127.0.0.1:4000/health/liveliness";
  if (label === LABEL_ANTIGRAVITY_PROXY)
    return "http://127.0.0.1:4002/health/liveliness";
  if (label === LABEL_COPILOT_PROXY)
    return "http://127.0.0.1:4003/health/liveliness";
  return "http://127.0.0.1:18765/health";
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

async function pollServiceReady(
  deps: ServiceRestartDeps,
  url: string,
  method: "GET" | "POST",
  attempts: number,
  delayMs: number
): Promise<boolean> {
  if (attempts <= 0) return false;
  if (await deps.probe(url, method)) return true;
  await deps.sleep(delayMs);
  return pollServiceReady(deps, url, method, attempts - 1, delayMs);
}

function waitForProbe(
  deps: ServiceRestartDeps,
  url: string,
  options: ServiceRestartOptions,
  method: "GET" | "POST" = "GET"
): Promise<boolean> {
  return pollServiceReady(
    deps,
    url,
    method,
    options.readyAttempts,
    options.readyDelayMs
  );
}

function reapUnmanaged(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel,
  deps: ServiceRestartDeps
): void {
  const pids = deps.listeningPids(SERVICE_PORTS[label]);
  if (pids === null) return;
  const hook = serviceHook(options, label);
  for (const pid of pids) {
    if (deps.commandLine(pid)?.includes(hook)) {
      writeErrorLine(
        `reaping unmanaged ${label} on port ${SERVICE_PORTS[label]} (pid ${pid})`
      );
      deps.kill(pid);
    } else {
      writeErrorLine(
        `port ${SERVICE_PORTS[label]} held by a process this installer does not own (pid ${pid}); ${label} not started`
      );
    }
  }
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

/** Restart only services owned by this CODEX_HOME and run direct fallbacks when launchd is unavailable. */
async function waitForSupervisedServices(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  includeCollector: boolean
): Promise<void> {
  if (!includeCollector) {
    await pollBridgeReadiness(deps, options, 0);
    return;
  }
  await pollBridgeReadiness(deps, options, 0);
  await waitForProbe(
    deps,
    "http://127.0.0.1:4318/v1/logs",
    options,
    "POST"
  );
}

async function pollBridgeReadiness(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  index: number
): Promise<void> {
  const labels = MANAGED_SERVICE_LABELS.slice(0, 5);
  if (index >= labels.length) return;
  const label = labels[index];
  if (label) await waitForProbe(deps, serviceProbe(label), options);
  await pollBridgeReadiness(deps, options, index + 1);
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

type ReloadResult = "ok" | "foreign" | "no-plist" | "disabled-otel" | "failed";

function reloadOneLabel(
  deps: ServiceRestartDeps,
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): ReloadResult {
  if (deps.launchd.isLoaded(label)) {
    const jobDump = readLaunchdJobDump(deps, label);
    if (!isOwnedService(options, label, jobDump)) {
      writeErrorLine(
        `loaded ${label} belongs to another runtime; leaving it alone.`
      );
      return "foreign";
    }
  }
  if (label === LABEL_OTEL_COLLECTOR && options.otelMode === "direct") {
    try {
      deps.launchd.bootout(label);
    } catch {
      /* not loaded */
    }
    return "disabled-otel";
  }
  const plist = plistPath(options, label);
  if (!deps.fileExists(plist)) return "no-plist";
  try {
    deps.launchd.bootout(label);
  } catch {
    /* not loaded */
  }
  reapUnmanaged(options, label, deps);
  try {
    deps.launchd.bootstrap(plist);
    try {
      deps.launchd.enable(label);
    } catch {
      /* best effort */
    }
    try {
      deps.launchd.kickstart(label);
    } catch {
      return "failed";
    }
    return "ok";
  } catch {
    return "failed";
  }
}

export async function restartServices(
  options: ServiceRestartOptions = resolveServiceRestartOptions(),
  deps: ServiceRestartDeps = defaultDeps()
): Promise<number> {
  const owner = plistOwner(options, deps);
  const foreignOwnerResult = foreignOwnedHookResult(options, owner);
  if (foreignOwnerResult !== null) return foreignOwnerResult;

  let launchdAvailable = deps.commandAvailable("launchctl");
  let foreignService = false;
  for (const label of MANAGED_SERVICE_LABELS) {
    const result = reloadOneLabel(deps, options, label);
    if (result === "foreign") {
      launchdAvailable = false;
      foreignService = true;
    } else if (result === "failed") launchdAvailable = false;
  }
  if (foreignService) {
    writeErrorLine(
      "another AutoDev runtime owns one or more labels; leaving all active services untouched."
    );
    return 0;
  }
  if (launchdAvailable)
    writeErrorLine(
      "Provider bridges supervised by launchd (KeepAlive; survive restart/crash/sleep)."
    );
  else
    writeErrorLine(
      "launchctl unavailable (sandbox?); starting bridges through the direct ensure-hook path."
    );
  await waitForSupervisedServices(
    deps,
    options,
    launchdAvailable && options.otelMode === "collector"
  );
  return runDirectEnsures(options, deps);
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
