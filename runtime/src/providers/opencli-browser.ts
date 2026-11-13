import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { OpencliSite } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { chromium } from "playwright-core";

const ACTIVE_PORT_LINE_BREAK = /\r?\n/u;

export class OpencliBrowserUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpencliBrowserUnavailableError";
  }
}

/** Resolve only the Chromium installed in AutoDev's private Playwright cache. */
export function resolveOpencliBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const home = env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const expectedCache = path.resolve(
    home,
    "provider-runtime",
    "opencli",
    "browsers"
  );
  const configuredCache = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!configuredCache || path.resolve(configuredCache) !== expectedCache)
    return null;
  const executable = path.resolve(chromium.executablePath());
  if (!executable.startsWith(`${expectedCache}${path.sep}`)) return null;
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    return null;
  }
  return executable;
}

export interface OpencliBrowserOptions {
  readonly executable: string;
  readonly siteTabs: Readonly<Record<OpencliSite, number>>;
  readonly profileDirectory?: string;
  readonly spawnBrowser?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly readinessTimeoutMs?: number;
}

/** Owns Chromium and leases a distinct CDP page target to every command. */
export class OpencliBrowser {
  readonly profileDirectory: string;
  private readonly spawnBrowser: typeof spawn;
  private readonly fetcher: typeof fetch;
  private readonly slots = new Map<OpencliSite, string[]>();
  private readonly busy = new Set<string>();
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<void> | null = null;
  private closing = false;
  private lastError: string | null = null;
  private launchError: Error | null = null;

  get isReady(): boolean {
    return this.port !== null && !this.closing && this.lastError === null;
  }
  get unavailableReason(): string | null {
    return this.lastError;
  }

  /** Start eagerly so the proxy does not become healthy before its browser is usable. */
  async initialize(): Promise<void> {
    try {
      await this.ensureReady();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private readonly options: OpencliBrowserOptions;
  constructor(options: OpencliBrowserOptions) {
    this.options = options;
    this.profileDirectory =
      options.profileDirectory ??
      path.join(
        process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
        "run",
        "opencli-browser-profile"
      );
    this.spawnBrowser = options.spawnBrowser ?? spawn;
    this.fetcher = options.fetch ?? fetch;
  }

  async run<T>(
    site: OpencliSite,
    signal: AbortSignal,
    command: (endpoint: string) => Promise<T>
  ): Promise<T> {
    let endpoint: string;
    try {
      await this.ensureReady();
      endpoint = await this.acquire(site, signal);
      this.lastError = null;
    } catch (error) {
      if (signal.aborted) throw error;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof OpencliBrowserUnavailableError) throw error;
      throw new OpencliBrowserUnavailableError(
        `Dedicated browser unavailable: ${this.lastError}`,
        { cause: error }
      );
    }
    try {
      return await command(endpoint);
    } finally {
      this.busy.delete(endpoint);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.starting?.catch(() => undefined);
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        }),
        delay(2000)
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise<void>((resolve) => {
            child.once("close", () => resolve());
          }),
          delay(1000)
        ]);
      }
    }
    this.child = null;
    this.port = null;
    this.slots.clear();
  }

  private async ensureReady(): Promise<void> {
    if (this.port !== null && (await this.version())) return;
    if (!this.starting)
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    await this.starting;
  }

  // Startup is intentionally one guarded transaction: any partial side effect is rolled back.
  // eslint-disable-next-line sonarjs/cognitive-complexity -- splitting the rollback path weakens lifecycle guarantees.
  private async start(): Promise<void> {
    if (this.closing)
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    if (!this.options.executable)
      throw new OpencliBrowserUnavailableError(
        "dedicated Chromium executable is unavailable from the AutoDev Playwright cache"
      );
    await this.stopChild();
    this.port = null;
    this.slots.clear();
    mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.profileDirectory, 0o700);
    try {
      unlinkSync(path.join(this.profileDirectory, "DevToolsActivePort"));
    } catch {
      /* no stale port file */
    }
    this.child = this.spawnBrowser(
      this.options.executable,
      [
        `--user-data-dir=${this.profileDirectory}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check"
      ],
      { stdio: "ignore", detached: false }
    );
    const child = this.child;
    this.launchError = null;
    child.once("error", (error) => {
      this.launchError = error;
    });
    child.once("close", () => {
      if (this.child === child && !this.closing) {
        this.port = null;
        this.slots.clear();
        this.lastError = "Dedicated Chromium exited unexpectedly";
      }
    });
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 20_000);
    try {
      while (Date.now() < deadline) {
        if (this.closing)
          throw new Error("dedicated opencli browser is shutting down");
        if (this.launchError) throw this.launchError;
        if (child.exitCode !== null)
          throw new Error(
            "dedicated opencli browser exited before CDP became ready"
          );
        let port: number | null = null;
        try {
          port = Number(
            readFileSync(
              path.join(this.profileDirectory, "DevToolsActivePort"),
              "utf8"
            ).split(ACTIVE_PORT_LINE_BREAK)[0]
          );
        } catch {
          /* ActivePort is written asynchronously during startup. */
        }
        if (port !== null && Number.isInteger(port) && port > 0) {
          this.port = port;
          // eslint-disable-next-line no-await-in-loop -- wait for CDP before creating its target pool.
          if (await this.version()) {
            // eslint-disable-next-line no-await-in-loop -- serial creation makes partial pool rollback deterministic.
            await this.createPool();
            this.lastError = null;
            return;
          }
        }
        // Polling ActivePort is necessary because Chromium writes it asynchronously.
        // eslint-disable-next-line no-await-in-loop -- ActivePort readiness is asynchronous.
        await delay(50);
      }
      throw new Error("dedicated opencli browser CDP readiness timed out");
    } catch (error) {
      this.port = null;
      this.slots.clear();
      await this.stopChild();
      throw new OpencliBrowserUnavailableError(
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      }),
      delay(1500)
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        }),
        delay(1000)
      ]);
    }
  }

  private async version(): Promise<boolean> {
    try {
      const response = await this.fetcher(
        `http://127.0.0.1:${this.port}/json/version`,
        { signal: AbortSignal.timeout(1000) }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async targets(): Promise<Array<{ webSocketDebuggerUrl: string }>> {
    let response: Response;
    try {
      response = await this.fetcher(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(1000)
      });
    } catch (error) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser target list unavailable",
        { cause: error }
      );
    }
    if (!response.ok)
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser target list unavailable"
      );
    try {
      return (await response.json()) as Array<{ webSocketDebuggerUrl: string }>;
    } catch (error) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser returned an invalid target list",
        { cause: error }
      );
    }
  }

  private async createTab(site: OpencliSite): Promise<string> {
    const url =
      site === "chatgpt"
        ? "https://chatgpt.com/"
        : "https://gemini.google.com/app";
    const response = await this.fetcher(
      `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT", signal: AbortSignal.timeout(3000) }
    );
    if (!response.ok)
      throw new OpencliBrowserUnavailableError(
        `could not create dedicated ${site} browser tab`
      );
    const target = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!target.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:"))
      throw new OpencliBrowserUnavailableError(
        "CDP returned a non-loopback target"
      );
    return target.webSocketDebuggerUrl;
  }

  private async createPool(): Promise<void> {
    this.slots.clear();
    for (const site of ["chatgpt", "gemini"] as const) {
      const targets: string[] = [];
      for (let i = 0; i < this.options.siteTabs[site]; i++) {
        // One CDP tab must be confirmed before requesting the next.
        // eslint-disable-next-line no-await-in-loop -- CDP tabs must exist before slot state is committed.
        targets.push(await this.createTab(site));
      }
      this.slots.set(site, targets);
    }
  }

  private async acquire(
    site: OpencliSite,
    signal: AbortSignal
  ): Promise<string> {
    while (!signal.aborted) {
      const slots = this.slots.get(site) ?? [];
      // A fresh target list is required to detect tabs closed since the last turn.
      // eslint-disable-next-line no-await-in-loop -- every retry needs a fresh target inventory.
      const currentTargets = await this.targets();
      const existing = new Set(
        currentTargets.map((target) => target.webSocketDebuggerUrl)
      );
      for (let i = 0; i < slots.length; i++) {
        let endpoint = slots[i]!;
        if (!existing.has(endpoint)) {
          // Replace the lost slot before leasing it to a command.
          // eslint-disable-next-line no-await-in-loop -- replacement target must be established before lease.
          endpoint = await this.createTab(site);
          slots[i] = endpoint;
        }
        if (!this.busy.has(endpoint)) {
          this.busy.add(endpoint);
          return endpoint;
        }
      }
      // Wait for a lease to free without allowing target-list failures to spin.
      // eslint-disable-next-line no-await-in-loop -- wait for another lease to become free.
      await delay(25, undefined, { signal }).catch(() => undefined);
    }
    throw new Error(
      "opencli browser command cancelled while waiting for a tab"
    );
  }
}
