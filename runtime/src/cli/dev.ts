#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export const IS_MAIN =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

export const repoRoot = path.resolve(resolveRuntimeSourceRoot(import.meta.dirname));

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

export function ensureConsoleSecrets(root = repoRoot): void {
  const consoleEnv = path.join(root, "console", ".env.local");
  const codexHome =
    process.env.CODEX_HOME?.trim() ||
    path.join(process.env.HOME || homedir(), ".codex");
  const canonicalSecrets =
    process.env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
    path.join(codexHome, "openlit-secrets.env");

  const script = path.join(root, "scripts", "openlit", "bootstrap-secrets.sh");
  if (!existsSync(script)) return;

  if (!existsSync(canonicalSecrets) || !existsSync(consoleEnv)) {
    writeLine("[dev] Initializing console secrets (console/.env.local)...");
    spawnSync("bash", [script], { stdio: "inherit", cwd: root });
    return;
  }

  // Canonical secrets and console/.env.local both exist; verify they stay synchronized.
  const parseToken = (filePath: string, key: string): string | null => {
    try {
      const content = readFileSync(filePath, "utf8");
      for (const line of content.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${key}=`)) {
          return trimmed.slice(key.length + 1).trim();
        }
      }
    } catch {
      return null;
    }
    return null;
  };

  const canonicalControlToken = parseToken(
    canonicalSecrets,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const canonicalUsageToken = parseToken(
    canonicalSecrets,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );
  const consoleControlToken = parseToken(
    consoleEnv,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const consoleUsageToken = parseToken(
    consoleEnv,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );

  if (
    !consoleControlToken ||
    !consoleUsageToken ||
    consoleControlToken !== canonicalControlToken ||
    consoleUsageToken !== canonicalUsageToken
  ) {
    writeLine(
      "[dev] Synchronizing console/.env.local with active OpenLIT secrets..."
    );
    spawnSync("bash", [script], { stdio: "inherit", cwd: root });
  }
}

export async function checkBackends(): Promise<{
  telemetryActive: boolean;
  routerActive: boolean;
}> {
  let telemetryActive = false;
  // 1. Check Docker / OpenLIT / ClickHouse
  try {
    const dockerCheck = spawnSync("docker", ["info"], { stdio: "ignore" });
    if (dockerCheck.status === 0) {
      const chRunning = await isPortListening(8123);
      const openlitRunning = await isPortListening(3000);
      if (chRunning && openlitRunning) {
        telemetryActive = true;
        writeLine(
          "[dev] ✔ OpenLIT & ClickHouse telemetry services are active (ports 3000, 4318, 8123)."
        );
      } else {
        const startCheck = spawnSync(
          "docker",
          ["start", "openlit-clickhouse", "openlit"],
          {
            stdio: "ignore"
          }
        );
        if (startCheck.status === 0) {
          telemetryActive = true;
          writeLine("[dev] ✔ Started existing OpenLIT & ClickHouse containers.");
        } else {
          writeLine(
            "[dev] ℹ OpenLIT containers not started (run `bash scripts/openlit/up.sh` if telemetry storage is needed)."
          );
        }
      }
    } else {
      writeLine(
        "[dev] ℹ Docker is not running; skipping telemetry database (ClickHouse/OpenLIT)."
      );
    }
  } catch {
    writeLine("[dev] ℹ Docker not found; skipping telemetry database.");
  }

  // 2. Check AutoDev Model Router
  const routerActive = await isPortListening(4100);
  if (routerActive) {
    writeLine("[dev] ✔ AutoDev Model Router is active (port 4100).");
  } else {
    writeLine(
      "[dev] ℹ AutoDev Model Router is not listening on port 4100 (run launchctl or scripts/run-codex-model-router.sh)."
    );
  }

  return { telemetryActive, routerActive };
}

export async function startDev(): Promise<void> {
  ensureConsoleSecrets();
  await checkBackends();

  const consolePort = process.env.AUTODEV_CONSOLE_PORT || "3300";
  writeLine(
    `[dev] 🚀 Starting AutoDev Console dev server on http://localhost:${consolePort}...\n`
  );

  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const extraArgs = process.argv.slice(2);
  const child = spawn(
    pnpmBin,
    ["--filter", "@simulatorlife/autodev-console", "dev", ...extraArgs],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTODEV_CONSOLE_PORT: consolePort
      }
    }
  );

  child.on("error", (error) => {
    writeErrorLine(`[dev] Failed to launch console: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  const forwardSignal = (sig: NodeJS.Signals) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}

if (IS_MAIN) {
  void startDev();
}
