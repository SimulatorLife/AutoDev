import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

export const MANAGED_SERVICE_LABELS = [
  "com.codex.model-router",
  "com.codex.claude-bridge",
  "com.codex.minimax-proxy",
  "com.codex.antigravity-proxy",
  "com.codex.copilot-proxy",
  "com.codex.otel-collector"
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
const SERVICE_PORTS: Record<ManagedServiceLabel, number> = {
  "com.codex.model-router": 4100,
  "com.codex.claude-bridge": 4000,
  "com.codex.minimax-proxy": 18_765,
  "com.codex.antigravity-proxy": 4002,
  "com.codex.copilot-proxy": 4003,
  "com.codex.otel-collector": 4318
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
  const parsed = Number.parseInt(value ?? "", 10);
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
        return (await fetch(url, { method, signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
          .split(/\s+/)
          .filter((pid) => /^[0-9]+$/.test(pid))
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
    case "com.codex.model-router": {
      return path.join(hooks, "run-codex-model-router.sh");
    }
    case "com.codex.claude-bridge": {
      return path.join(hooks, "run-codex-claude-bridge.sh");
    }
    case "com.codex.antigravity-proxy": {
      return path.join(hooks, "run-codex-antigravity-proxy.sh");
    }
    case "com.codex.copilot-proxy": {
      return path.join(hooks, "run-codex-copilot-cli-responses-proxy.sh");
    }
    case "com.codex.minimax-proxy": {
      return path.join(hooks, "ensure-codex-minimax-proxy.sh");
    }
    case "com.codex.otel-collector": {
      return path.join(hooks, "otel", "run-autodev-otel-collector.sh");
    }
  }
}

function serviceHook(
  options: ServiceRestartOptions,
  label: ManagedServiceLabel
): string {
  switch (label) {
    case "com.codex.model-router": {
      return path.join(options.codexHome, "src", "router", "server.ts");
    }
    case "com.codex.claude-bridge": {
      return path.join(options.codexHome, "src", "providers", "claude.ts");
    }
    case "com.codex.antigravity-proxy": {
      return path.join(options.codexHome, "src", "providers", "antigravity.ts");
    }
    case "com.codex.copilot-proxy": {
      return path.join(options.codexHome, "src", "providers", "copilot.ts");
    }
    case "com.codex.minimax-proxy": {
      return path.join(options.codexHome, "src", "providers", "minimax.ts");
    }
    case "com.codex.otel-collector": {
      return serviceLauncher(options, label);
    }
  }
}

function serviceProbe(label: ManagedServiceLabel): string {
  if (label === "com.codex.model-router")
    return "http://127.0.0.1:4100/health/readiness";
  if (label === "com.codex.claude-bridge")
    return "http://127.0.0.1:4000/health/liveliness";
  if (label === "com.codex.antigravity-proxy")
    return "http://127.0.0.1:4002/health/liveliness";
  if (label === "com.codex.copilot-proxy")
    return "http://127.0.0.1:4003/health/liveliness";
  return "http://127.0.0.1:18765/health";
}

function plistOwner(
  options: ServiceRestartOptions,
  deps: ServiceRestartDeps
): string | null {
  const filePath = plistPath(options, "com.codex.model-router");
  if (!deps.fileExists(filePath)) return null;
  const match = /<key>CODEX_HOME<\/key>\s*<string>([^<]+)<\/string>/u.exec(
    deps.readFile(filePath)
  );
  return match?.[1] ?? null;
}

async function waitForProbe(
  deps: ServiceRestartDeps,
  url: string,
  options: ServiceRestartOptions,
  method: "GET" | "POST" = "GET"
): Promise<boolean> {
  for (let attempt = 0; attempt < options.readyAttempts; attempt += 1) {
    if (await deps.probe(url, method)) return true;
    await deps.sleep(options.readyDelayMs);
  }
  return false;
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
  const run = (
    script: string,
    input?: string,
    env?: NodeJS.ProcessEnv
  ): number => deps.run("/bin/bash", [script], input, env);
  if (
    run(
      path.join(options.repositoryRoot, "scripts", "ensure-codex-model-router.sh")
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
      path.join(options.repositoryRoot, "scripts", "ensure-codex-copilot-proxy.sh")
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
export async function restartServices(
  options: ServiceRestartOptions = resolveServiceRestartOptions(),
  deps: ServiceRestartDeps = defaultDeps()
): Promise<number> {
  const owner = plistOwner(options, deps);
  if (owner && path.join(options.codexHome, "hooks") !== path.join(owner, "hooks")) {
    writeErrorLine(
      `materialized into ${path.join(options.codexHome, "hooks")}; leaving the services under ${path.join(owner, "hooks")} alone.`
    );
    return 0;
  }

  let launchdAvailable = deps.commandAvailable("launchctl");
  let foreignService = false;
  for (const label of MANAGED_SERVICE_LABELS) {
    if (deps.launchd.isLoaded(label)) {
      let jobDump = "";
      try {
        jobDump = deps.launchd.print(label);
      } catch {
        /* treat as unavailable */
      }
      if (!isOwnedService(options, label, jobDump)) {
        writeErrorLine(
          `loaded ${label} belongs to another runtime; leaving it alone.`
        );
        launchdAvailable = false;
        foreignService = true;
        continue;
      }
    }
    if (label === "com.codex.otel-collector" && options.otelMode === "direct") {
      try {
        deps.launchd.bootout(label);
      } catch {
        /* not loaded */
      }
      continue;
    }
    const plist = plistPath(options, label);
    if (!deps.fileExists(plist)) {
      launchdAvailable = false;
      continue;
    }
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
        launchdAvailable = false;
      }
    } catch {
      launchdAvailable = false;
    }
  }
  if (foreignService) {
    writeErrorLine(
      "another AutoDev runtime owns one or more labels; leaving all active services untouched."
    );
    return 0;
  }
  if (launchdAvailable) {
    writeErrorLine(
      "Provider bridges supervised by launchd (KeepAlive; survive restart/crash/sleep)."
    );
    for (const label of MANAGED_SERVICE_LABELS.slice(0, 5))
      await waitForProbe(deps, serviceProbe(label), options);
    if (options.otelMode === "collector")
      await waitForProbe(
        deps,
        "http://127.0.0.1:4318/v1/logs",
        options,
        "POST"
      );
  } else {
    writeErrorLine(
      "launchctl unavailable (sandbox?); starting bridges through the direct ensure-hook path."
    );
  }
  return runDirectEnsures(options, deps);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  restartServices().then((status) => {
    process.exitCode = status;
  });
}
