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

import {
  OPENCLI_SITES,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
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

const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 3000;

export type OpencliCdpCommand = (
  wsUrl: string,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

function assertLoopbackCdpWs(wsUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new OpencliBrowserUnavailableError("CDP returned an invalid WebSocket URL");
  }
  if (
    parsed.protocol !== "ws:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new OpencliBrowserUnavailableError("CDP returned a non-loopback target");
  }
}

async function defaultCdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  assertLoopbackCdpWs(wsUrl);
  const timeout = AbortSignal.timeout(DEFAULT_CDP_COMMAND_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      combined.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
      fn();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(
          new OpencliBrowserUnavailableError("CDP browser command timed out or cancelled")
        )
      );
    combined.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("error", () => {
      finish(() =>
        reject(new OpencliBrowserUnavailableError("CDP browser socket error"))
      );
    });
    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (payload.id !== 1) return;
        if (payload.error) {
          finish(() =>
            reject(
              new OpencliBrowserUnavailableError(
                payload.error?.message || `CDP ${method} failed`
              )
            )
          );
          return;
        }
        finish(() => resolve(payload.result ?? {}));
      } catch {
        // Ignore malformed frame and await reply or timeout.
      }
    });
  });
}

export interface OpencliBrowserOptions {
  readonly executable: string;
  readonly siteTabs: Readonly<Record<OpencliSite, number>>;
  readonly profileDirectory?: string;
  readonly spawnBrowser?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly cdpCommand?: OpencliCdpCommand;
  readonly readinessTimeoutMs?: number;
}

/** Owns Chromium and leases a distinct CDP page window/target to every command. */
export class OpencliBrowser {
  readonly profileDirectory: string;
  private readonly spawnBrowser: typeof spawn;
  private readonly fetcher: typeof fetch;
  private readonly cdpCommand: OpencliCdpCommand;
  private readonly slots = new Map<OpencliSite, string[]>();
  private readonly busy = new Set<string>();
  private visibleLease: string | null = null;
  private readonly visibleQueue: symbol[] = [];
  private creatingTarget = false;
  /** A command settled without process close; its target must not be leased. */
  private readonly quarantined = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private changeRevision = 0;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private browserWsUrl: string | null = null;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private closing = false;
  /** A stop that waits for the commands holding leases to finish. */
  private stopWhenIdle = false;
  private lastError: string | null = null;
  private launchError: Error | null = null;

  get isReady(): boolean {
    return (
      this.port !== null &&
      this.slots.size === OPENCLI_SITES.length &&
      !this.closing &&
      this.lastError === null
    );
  }
  get unavailableReason(): string | null {
    return this.lastError;
  }

  /** Start eagerly so the proxy does not become healthy before its browser is usable. */
  async initialize(): Promise<void> {
    this.stopWhenIdle = false;
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
    this.cdpCommand = options.cdpCommand ?? defaultCdpCommand;
  }

  private notify(): void {
    this.changeRevision += 1;
    for (const wake of [...this.waiters]) wake();
  }

  private waitForChange(
    signal: AbortSignal,
    observedRevision: number
  ): Promise<void> {
    if (signal.aborted || this.changeRevision !== observedRevision) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  async run<T>(
    site: OpencliSite,
    signal: AbortSignal,
    command: (endpoint: string, releaseForeground: () => void) => Promise<T>,
    requiresVisiblePage = false
  ): Promise<T> {
    if (this.closing) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    }
    let lease: { endpoint: string; generation: number };
    this.stopWhenIdle = false;
    try {
      await this.ensureReady();
      lease = await this.acquire(site, signal, requiresVisiblePage);
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
    const { endpoint, generation } = lease;
    let foregroundReleased = !requiresVisiblePage;
    const releaseForeground = (): void => {
      if (foregroundReleased) return;
      foregroundReleased = true;
      if (
        this.generation === generation &&
        this.visibleLease === endpoint &&
        !this.quarantined.has(endpoint)
      ) {
        this.visibleLease = null;
        this.notify();
      }
    };
    try {
      if (requiresVisiblePage) {
        await this.activateTarget(endpoint, signal);
      }
      signal.throwIfAborted();
      if (this.generation !== generation || this.closing) {
        throw new OpencliBrowserUnavailableError(
          "Dedicated Chromium stopped before command dispatch"
        );
      }
      return await command(endpoint, releaseForeground);
    } finally {
      // Keep the lease held if the CLI outlives its caller's cancellation, and
      // never let a stale crashed-generation command corrupt a new browser run.
      if (this.generation === generation && !this.quarantined.has(endpoint)) {
        this.busy.delete(endpoint);
        if (this.visibleLease === endpoint) this.visibleLease = null;
        this.notify();
        if (this.stopWhenIdle && this.busy.size === 0) void this.shutDown();
      }
    }
  }

  private async activateTarget(
    endpoint: string,
    signal: AbortSignal
  ): Promise<void> {
    // Activate only the leased target using Chromium's native CDP endpoint and
    // restore minimized windows when possible. Do not spoof
    // document.visibilityState or bypass OpenCLI's input guard.
    const target = new URL(endpoint).pathname.split("/").pop();
    if (!target) {
      throw new OpencliBrowserUnavailableError("Missing CDP target identity.");
    }
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    const browserWs = this.browserWsUrl;
    if (browserWs) {
      try {
        const win = (await this.cdpCommand(
          browserWs,
          "Browser.getWindowForTarget",
          { targetId: target },
          combinedSignal
        )) as { windowId?: number; bounds?: { windowState?: string } };
        if (
          typeof win.windowId === "number" &&
          win.bounds?.windowState === "minimized"
        ) {
          await this.cdpCommand(
            browserWs,
            "Browser.setWindowBounds",
            { windowId: win.windowId, bounds: { windowState: "normal" } },
            combinedSignal
          );
        }
        await this.cdpCommand(
          browserWs,
          "Target.activateTarget",
          { targetId: target },
          combinedSignal
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // Fall through to HTTP /json/activate for older/mock CDP targets.
      }
    }
    const response = await this.fetcher(
      `http://127.0.0.1:${this.port}/json/activate/${encodeURIComponent(target)}`,
      { signal: combinedSignal }
    );
    if (!response.ok) {
      throw new OpencliBrowserUnavailableError(
        "Could not activate the leased browser tab."
      );
    }
  }

  /** A cancelled CLI has not emitted close; isolate only its own CDP target. */
  quarantine(endpoint: string): void {
    this.quarantined.add(endpoint);
    this.busy.add(endpoint);
  }

  /** The CLI has now closed, so its CDP target can be leased again. */
  releaseQuarantine(endpoint: string): void {
    this.quarantined.delete(endpoint);
    this.busy.delete(endpoint);
    if (this.visibleLease === endpoint) this.visibleLease = null;
    this.notify();
    if (this.stopWhenIdle && this.busy.size === 0) void this.shutDown();
  }

  /**
   * Shut the browser down when the operator turns the dedicated browser off.
   *
   * Unlike `close`, the owner stays usable: turning the setting back on starts
   * the browser again. Commands already holding a tab finish first.
   */
  async stop(): Promise<void> {
    this.stopWhenIdle = true;
    this.notify();
    await this.starting?.catch(() => undefined);
    if (this.busy.size > 0) {
      return;
    }
    await this.shutDown();
  }

  private resetState(): void {
    this.generation += 1;
    this.port = null;
    this.browserWsUrl = null;
    this.slots.clear();
    this.busy.clear();
    this.quarantined.clear();
    this.visibleLease = null;
    this.creatingTarget = false;
    this.notify();
  }

  private async shutDown(): Promise<void> {
    this.stopWhenIdle = false;
    this.resetState();
    this.lastError = null;
    await this.stopChild();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stopWhenIdle = false;
    this.notify();
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
    this.resetState();
  }

  private async ensureReady(): Promise<void> {
    if (this.closing) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    }
    // Share the entire readiness transaction, including the health probe.
    // The CDP port is published before the target pool is created; a caller
    // must not bypass an in-progress start just because /json/version works.
    if (!this.starting) {
      this.starting = this.checkReady().finally(() => {
        this.starting = null;
        this.notify();
      });
    }
    await this.starting;
  }

  private async checkReady(): Promise<void> {
    if (
      this.port !== null &&
      this.slots.size === OPENCLI_SITES.length &&
      (await this.version())
    ) {
      return;
    }
    // An unavailable health endpoint does not prove Chromium has exited.
    // Do not terminate unrelated in-flight turns to recover a new caller.
    if (this.busy.size > 0) {
      throw new OpencliBrowserUnavailableError(
        "Dedicated Chromium health probe failed while commands are active"
      );
    }
    await this.start();
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
    this.resetState();
    if (this.closing || this.stopWhenIdle) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    }
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
      this.notify();
    });
    child.once("close", () => {
      if (this.child === child && !this.closing) {
        this.child = null;
        this.resetState();
        this.lastError = "Dedicated Chromium exited unexpectedly";
      }
    });
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 20_000);
    try {
      while (Date.now() < deadline) {
        if (this.closing || this.stopWhenIdle)
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
            if (this.closing || this.stopWhenIdle) {
              throw new Error("dedicated opencli browser is shutting down");
            }
            // eslint-disable-next-line no-await-in-loop -- serial creation makes partial pool rollback deterministic.
            await this.createPool();
            this.lastError = null;
            this.notify();
            return;
          }
        }
        // Polling ActivePort is necessary because Chromium writes it asynchronously.
        // eslint-disable-next-line no-await-in-loop -- ActivePort readiness is asynchronous.
        await delay(50);
      }
      throw new Error("dedicated opencli browser CDP readiness timed out");
    } catch (error) {
      this.resetState();
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
    const port = this.port;
    const generation = this.generation;
    if (port === null) return false;
    try {
      const response = await this.fetcher(
        `http://127.0.0.1:${port}/json/version`,
        { signal: AbortSignal.timeout(1000) }
      );
      if (!response.ok) return false;
      try {
        const payload = (await response.json()) as {
          webSocketDebuggerUrl?: unknown;
        };
        if (generation !== this.generation || port !== this.port) return false;
        if (
          typeof payload.webSocketDebuggerUrl === "string" &&
          payload.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")
        ) {
          this.browserWsUrl = payload.webSocketDebuggerUrl;
        }
      } catch {
        // Test mocks may return `{}` or empty body for /json/version.
      }
      return generation === this.generation && port === this.port;
    } catch {
      return false;
    }
  }

  private async targets(): Promise<
    Array<{ id?: string; webSocketDebuggerUrl: string }>
  > {
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
      return (await response.json()) as Array<{
        id?: string;
        webSocketDebuggerUrl: string;
      }>;
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
    if (this.browserWsUrl) {
      try {
        const created = (await this.cdpCommand(
          this.browserWsUrl,
          "Target.createTarget",
          { url, newWindow: true }
        )) as { targetId?: unknown };
        if (typeof created.targetId === "string" && created.targetId) {
          const listed = await this.targets();
          const matched = listed.find(
            (target) =>
              target.id === created.targetId ||
              target.webSocketDebuggerUrl.endsWith(`/${created.targetId}`)
          );
          if (matched?.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:")) {
            return matched.webSocketDebuggerUrl;
          }
          if (matched?.webSocketDebuggerUrl) {
            throw new OpencliBrowserUnavailableError(
              "CDP returned a non-loopback target"
            );
          }
        }
      } catch (error) {
        if (
          error instanceof OpencliBrowserUnavailableError &&
          error.message === "CDP returned a non-loopback target"
        ) {
          throw error;
        }
        // Fall through to HTTP /json/new if Target.createTarget fails.
      }
    }
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
    const generation = this.generation;
    this.slots.clear();
    for (const site of OPENCLI_SITES) {
      const targets: string[] = [];
      for (let i = 0; i < this.options.siteTabs[site]; i++) {
        // One CDP window/tab must be confirmed before requesting the next.
        // eslint-disable-next-line no-await-in-loop -- CDP tabs must exist before slot state is committed.
        targets.push(await this.createTab(site));
        if (
          generation !== this.generation ||
          this.closing ||
          this.stopWhenIdle
        ) {
          throw new OpencliBrowserUnavailableError(
            "Dedicated Chromium stopped during target pool creation"
          );
        }
      }
      this.slots.set(site, targets);
    }
  }

  private async acquire(
    site: OpencliSite,
    signal: AbortSignal,
    requiresVisiblePage: boolean
  ): Promise<{ endpoint: string; generation: number }> {
    const ticket = requiresVisiblePage ? Symbol("visible-lease") : null;
    if (ticket) this.visibleQueue.push(ticket);
    const canLease = (): boolean =>
      !this.closing &&
      !this.stopWhenIdle &&
      !this.creatingTarget &&
      (!requiresVisiblePage ||
        (this.visibleLease === null && this.visibleQueue[0] === ticket));
    try {
      while (!signal.aborted) {
        const observedRevision = this.changeRevision;
        if (this.closing || this.stopWhenIdle) {
          throw new OpencliBrowserUnavailableError(
            "dedicated opencli browser is shutting down"
          );
        }
        if (this.starting || this.port === null) {
          // Recover transparently if Chromium exited while waiting, and
          // await the entire replacement pool before inspecting slots.
          // eslint-disable-next-line no-await-in-loop -- recovery must precede slot lookup.
          await this.ensureReady();
        }
        if (!canLease()) {
          // A visible native-input turn owns foreground activation during its
          // input/submission phase; wait cleanly until notified.
          // eslint-disable-next-line no-await-in-loop -- wait for the current lease.
          await this.waitForChange(signal, observedRevision);
          continue;
        }
        const gen = this.generation;
        const slots = this.slots.get(site) ?? [];
        const snapshot = [...slots];
        // A fresh target list is required to detect tabs closed since the last turn.
        // eslint-disable-next-line no-await-in-loop -- every retry needs a fresh target inventory.
        const currentTargets = await this.targets();
        if (gen !== this.generation) continue;
        const existing = new Set(
          currentTargets.map((target) => target.webSocketDebuggerUrl)
        );
        for (let i = 0; i < slots.length; i++) {
          if (!canLease() || signal.aborted || gen !== this.generation) break;
          let endpoint = slots[i]!;
          // Another acquisition may have replaced a slot while our target
          // inventory was in flight. Never replace a newly assigned or busy
          // target based on that stale snapshot.
          if (
            endpoint !== snapshot[i] ||
            this.busy.has(endpoint) ||
            this.quarantined.has(endpoint)
          ) {
            continue;
          }
          if (!existing.has(endpoint)) {
            // Creating a target activates it. Skip missing slots while a
            // foreground turn owns native input; re-evaluate after release
            // rather than resume this stale inventory inside a nested wait.
            if (this.visibleLease !== null) continue;
            this.creatingTarget = true;
            try {
              // eslint-disable-next-line no-await-in-loop -- replacement must finish before leasing.
              endpoint = await this.createTab(site);
              if (gen !== this.generation) break;
              slots[i] = endpoint;
            } finally {
              if (gen === this.generation) {
                this.creatingTarget = false;
                this.notify();
              }
            }
          }
          if (
            canLease() &&
            !signal.aborted &&
            gen === this.generation &&
            !this.busy.has(endpoint) &&
            !this.quarantined.has(endpoint)
          ) {
            this.busy.add(endpoint);
            if (requiresVisiblePage) this.visibleLease = endpoint;
            return { endpoint, generation: gen };
          }
        }
        // Wait for a lease to free without spinning on target list fetches.
        // eslint-disable-next-line no-await-in-loop -- wait for another lease to become free.
        await this.waitForChange(signal, observedRevision);
      }
      throw new Error(
        "opencli browser command cancelled while waiting for a tab"
      );
    } finally {
      if (ticket) {
        const index = this.visibleQueue.indexOf(ticket);
        if (index !== -1) this.visibleQueue.splice(index, 1);
        this.notify();
      }
    }
  }
}
