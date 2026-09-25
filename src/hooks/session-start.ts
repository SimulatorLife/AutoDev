#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDefaultRouterEnsureDeps,
  resolveRouterEnsureOptions,
  type RouterEnsureDeps,
  type RouterEnsureOptions,
  type RouterEnsureResult,
  runRouterEnsure
} from "../platform/router-ensure.ts";

export function runRepoBootstrapSync(cwd = process.cwd()): number {
  const scriptCandidates = [
    path.join(
      process.env.HOME ?? homedir(),
      ".local",
      "bin",
      "autodev-bootstrap"
    ),
    path.join(
      fileURLToPath(new URL("../../", import.meta.url)),
      "scripts",
      "bootstrap-repo-exclusions.sh"
    )
  ];
  for (const script of scriptCandidates) {
    if (existsSync(script)) {
      try {
        execFileSync(script, [cwd], { stdio: "ignore" });
        return 0;
      } catch {
        return 1;
      }
    }
  }
  return 0;
}

export interface SessionStartRunner {
  runRouterEnsure(
    deps: RouterEnsureDeps,
    options: RouterEnsureOptions
  ): Promise<RouterEnsureResult>;
  runRepoBootstrap?(cwd: string): Promise<number>;
}

export const defaultSessionStartRunner: SessionStartRunner = {
  runRouterEnsure,
  runRepoBootstrap: (cwd: string) => Promise.resolve(runRepoBootstrapSync(cwd))
};

export function createSessionStart(
  runner: SessionStartRunner = defaultSessionStartRunner
): (input?: Buffer | string) => Promise<number> {
  return async function runSessionStart(
    _input = readFileSync(0)
  ): Promise<number> {
    const options = resolveRouterEnsureOptions(process.env, process.pid);
    const deps = createDefaultRouterEnsureDeps(options);
    const result = await runner.runRouterEnsure(deps, options);
    if (result.message && result.exitCode !== 0)
      process.stderr.write(`${result.message}\n`);
    if (result.logTail && result.logTail.length > 0) {
      for (const line of result.logTail) process.stderr.write(`${line}\n`);
    }
    if (result.exitCode === 0 && runner.runRepoBootstrap) {
      await runner.runRepoBootstrap(process.cwd());
    }
    return result.exitCode;
  };
}

export const runSessionStart: (input?: Buffer | string) => Promise<number> =
  createSessionStart();

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.exitCode = await runSessionStart();
}
