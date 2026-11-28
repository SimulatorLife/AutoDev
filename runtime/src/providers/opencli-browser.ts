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

import { isPathWithin } from "@simulatorlife/autodev-data/files";
import { type OpencliSite } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import PQueue from "p-queue";
import { chromium } from "playwright-core";

const ACTIVE_PORT_LINE_BREAK = /\r?\n/u;

export class OpencliBrowserUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpencliBrowserUnavailableError";
  }
}

/**
A background probe asked for a site page that is not open. Nothing was
launched or opened on its behalf.
*/
export class OpencliSitePageNotOpenError extends Error {
  constructor(site: OpencliSite) {
    super(`No ${site} page is open in the dedicated browser.`);
    this.name = "OpencliSitePageNotOpenError";
  }
}

/**
The page a site's turns start from; a tab on the same host is that site's.
*/
const SITE_HOME: Readonly<Record<OpencliSite, string>> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app"
};
/**
Pages Chromium opens with nothing in them, which a site may take over.
*/
const BLANK_PAGE_URLS = new Set([
  "about:blank",
  "chrome://newtab/",
  "chrome://new-tab-page/"
]);
const EXECUTABLE_MISSING =
  "dedicated Chromium executable is unavailable from the AutoDev Playwright cache";

function pageHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
Resolve only the Chromium installed in AutoDev's private Playwright cache.
*/
export function resolveOpencliBrowserExecutable(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const home = environment.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const expectedCache = path.resolve(
    home,
    "provider-runtime",
    "opencli",
    "browsers"
  );
  const configuredCache = environment.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!configuredCache || path.resolve(configuredCache) !== expectedCache)
    return null;
  const executable = path.resolve(chromium.executablePath());
  if (executable === expectedCache || !isPathWithin(expectedCache, executable))
    return null;
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    return null;
  }
  return executable;
}

const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 3000;
// macOS raises the window asynchronously, so visibility is read more than once.
const VISIBILITY_READ_ATTEMPTS = 3;
const VISIBILITY_READ_DELAY_MS = 150;

export type OpencliCdpCommand = (
  wsUrl: string,
  method: string,
  parameters?: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

function assertLoopbackCdpWs(wsUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new OpencliBrowserUnavailableError(
      "CDP returned an invalid WebSocket URL"
    );
  }
  if (
    parsed.protocol !== "ws:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new OpencliBrowserUnavailableError(
      "CDP returned a non-loopback target"
    );
  }
}

async function defaultCdpCommand(
  wsUrl: string,
  method: string,
  parameters: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  assertLoopbackCdpWs(wsUrl);
  const timeout = AbortSignal.timeout(DEFAULT_CDP_COMMAND_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let isSettled = false;
    const finish = (function_: () => void): void => {
      if (isSettled) return;
      isSettled = true;
      combined.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
      function_();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(
          new OpencliBrowserUnavailableError(
            "CDP browser command timed out or cancelled"
          )
        )
      );
    combined.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params: parameters }));
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

interface CdpTarget {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl: string;
}

export interface OpencliRunOptions {
  /**
  The command dispatches native input, so its page must be in front.
  */
  readonly requiresVisiblePage?: boolean;
  /**
  Start the browser and open the site's page when neither exists. A
  background probe passes false: it runs only on a page that is already
  open, and fails with `OpencliSitePageNotOpenError` otherwise.
  */
  readonly shouldOpenPage?: boolean;
}

export interface OpencliBrowserOptions {
  readonly executable: string;
  /**
  The most tabs each site may hold: one per concurrent turn its route admits.
  */
  readonly siteTabs: Readonly<Record<OpencliSite, number>>;
  readonly profileDirectory?: string;
  readonly spawnBrowser?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly cdpCommand?: OpencliCdpCommand;
  readonly readinessTimeoutMs?: number;
}

/**
Owns the dedicated Chromium and leases a distinct CDP page target to every
command.

Nothing opens until a command needs it: the browser starts on the first site
command, and each site's tabs are found or opened one at a time as
concurrent turns need them, preferring a tab already on that site, then a
blank tab, and only then a new tab in the existing window. The browser
outlives this owner, so a restarted bridge adopts it and its tabs.
*/
export class OpencliBrowser {
  readonly profileDirectory: string;
  private readonly spawnBrowser: typeof spawn;
  private readonly fetcher: typeof fetch;
  private readonly cdpCommand: OpencliCdpCommand;
  private readonly slots = new Map<OpencliSite, string[]>();
  private readonly busy = new Set<string>();
  private visibleLease: string | null = null;
  private readonly foregroundQueue = new PQueue({ concurrency: 1 });
  private activeForegroundRelease: (() => void) | null = null;
  private creatingTarget = false;
  /**
  A command settled without process close; its target must not be leased.
  */
  private readonly quarantined = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private changeRevision = 0;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private browserWsUrl: string | null = null;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private closing = false;
  private lastError: string | null = null;
  private launchError: Error | null = null;

  /**
  Whether this owner is attached to a running browser.
  */
  get isRunning(): boolean {
    return this.port !== null && this.starting === null && !this.closing;
  }

  /**
  Why the next command cannot be served, or null when it can. A browser that
  is not running is not a fault: the next command starts it.
  */
  get unavailableReason(): string | null {
    if (!this.options.executable) return EXECUTABLE_MISSING;
    return this.lastError;
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
    options: OpencliRunOptions = {}
  ): Promise<T> {
    if (this.closing) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    }
    const requiresVisiblePage = options.requiresVisiblePage ?? false;
    const shouldOpenPage = options.shouldOpenPage ?? true;
    const recordAcquireError = (error: unknown): never => {
      // A probe observes; it neither raises nor clears the browser's fault.
      if (!shouldOpenPage || signal.aborted) throw error;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof OpencliBrowserUnavailableError) throw error;
      throw new OpencliBrowserUnavailableError(
        `Dedicated browser unavailable: ${this.lastError}`,
        { cause: error }
      );
    };
    if (!requiresVisiblePage) {
      let lease: { endpoint: string; generation: number };
      try {
        if (shouldOpenPage) await this.ensureReady();
        lease = await this.acquire(site, signal, false, shouldOpenPage);
        if (shouldOpenPage) this.lastError = null;
      } catch (error) {
        recordAcquireError(error);
      }
      try {
        signal.throwIfAborted();
        if (this.generation !== lease!.generation || this.closing) {
          throw new OpencliBrowserUnavailableError(
            "Dedicated Chromium stopped before command dispatch"
          );
        }
        return await command(lease!.endpoint, () => undefined);
      } finally {
        if (
          this.generation === lease!.generation &&
          !this.quarantined.has(lease!.endpoint)
        ) {
          this.busy.delete(lease!.endpoint);
          this.notify();
        }
      }
    }
    return this.runVisible(
      site,
      signal,
      command,
      shouldOpenPage,
      recordAcquireError
    );
  }

  private async runVisible<T>(
    site: OpencliSite,
    signal: AbortSignal,
    command: (endpoint: string, releaseForeground: () => void) => Promise<T>,
    shouldOpenPage: boolean,
    recordAcquireError: (error: unknown) => never
  ): Promise<T> {
    const {
      promise: acquiredPromise,
      resolve: resolveAcquired,
      reject: rejectAcquired
    } = Promise.withResolvers<{
      endpoint: string;
      generation: number;
      releaseForeground: () => void;
    }>();
    const enqueueForeground = async (): Promise<void> => {
      try {
        await this.foregroundQueue.add(
          async () => {
            const { promise: gatePromise, resolve: releaseGate } =
              Promise.withResolvers<void>();
            let isGateReleased = false;
            const finishGate = (): void => {
              if (isGateReleased) return;
              isGateReleased = true;
              if (this.activeForegroundRelease === finishGate) {
                this.activeForegroundRelease = null;
              }
              releaseGate();
            };
            this.activeForegroundRelease = finishGate;
            try {
              if (shouldOpenPage) await this.ensureReady();
              const lease = await this.acquire(
                site,
                signal,
                true,
                shouldOpenPage
              );
              try {
                await this.activateTarget(lease.endpoint, signal);
                signal.throwIfAborted();
                if (this.generation !== lease.generation || this.closing) {
                  throw new OpencliBrowserUnavailableError(
                    "Dedicated Chromium stopped before command dispatch"
                  );
                }
              } catch (activationError) {
                if (
                  this.generation === lease.generation &&
                  !this.quarantined.has(lease.endpoint)
                ) {
                  this.busy.delete(lease.endpoint);
                  if (this.visibleLease === lease.endpoint) {
                    this.visibleLease = null;
                  }
                  this.notify();
                }
                throw activationError;
              }
              if (shouldOpenPage) this.lastError = null;
              resolveAcquired({
                ...lease,
                releaseForeground: () => {
                  if (
                    this.generation === lease.generation &&
                    this.visibleLease === lease.endpoint &&
                    !this.quarantined.has(lease.endpoint)
                  ) {
                    this.visibleLease = null;
                    this.notify();
                  }
                  finishGate();
                }
              });
              await gatePromise;
            } catch (error) {
              finishGate();
              rejectAcquired(error);
            }
          },
          { signal }
        );
      } catch (error) {
        if (signal.aborted) {
          rejectAcquired(
            new Error(
              "opencli browser command cancelled while waiting for a tab",
              { cause: error }
            )
          );
          return;
        }
        rejectAcquired(error);
      }
    };
    void enqueueForeground();

    let acquired: {
      endpoint: string;
      generation: number;
      releaseForeground: () => void;
    };
    try {
      acquired = await acquiredPromise;
    } catch (error) {
      recordAcquireError(error);
    }
    const { endpoint, generation, releaseForeground } = acquired!;
    try {
      return await command(endpoint, releaseForeground);
    } finally {
      // Keep the lease held if the CLI outlives its caller's cancellation, and
      // never let a stale crashed-generation command corrupt a new browser run.
      if (this.generation === generation && !this.quarantined.has(endpoint)) {
        this.busy.delete(endpoint);
        releaseForeground();
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
    // Target.activateTarget only focuses the target inside its own window. The
    // page domain raises that window as well, which is what a native click
    // needs: Chromium reports the page as hidden while its window is
    // minimised, covered by another window, or on another Space.
    await this.bringPageToFront(endpoint, signal);
    const response = await this.fetcher(
      `http://127.0.0.1:${this.port}/json/activate/${encodeURIComponent(target)}`,
      { signal: combinedSignal }
    );
    if (!response.ok) {
      throw new OpencliBrowserUnavailableError(
        "Could not activate the leased browser tab."
      );
    }
    await this.assertPageVisible(endpoint, signal);
  }

  // Raise the leased page so Chromium really considers it visible.
  //
  // This is the genuine activation primitive; it is not a visibility spoof.
  // A target that does not expose the page domain is left to the
  // browser-level activation and the HTTP endpoint.
  private async bringPageToFront(
    endpoint: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.cdpCommand(
        endpoint,
        "Page.bringToFront",
        {},
        AbortSignal.any([signal, AbortSignal.timeout(3000)])
      );
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }

  // Report the leased page's own visibility instead of letting the native
  // input guard fail later with an opaque message.
  //
  // The read is only a diagnosis: when the state cannot be observed the turn
  // continues and the site's own guard decides.
  private async assertPageVisible(
    endpoint: string,
    signal: AbortSignal
  ): Promise<void> {
    for (let attempt = 1; attempt <= VISIBILITY_READ_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- each attempt must observe the window raise.
      const visibility = await this.readPageVisibility(endpoint, signal);
      if (visibility === null || visibility === "visible") return;
      if (attempt < VISIBILITY_READ_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop -- the retry delay is the point of the loop.
        await delay(VISIBILITY_READ_DELAY_MS);
        continue;
      }
      throw new OpencliBrowserUnavailableError(
        `The leased browser page is not visible (document.visibilityState is "${visibility}"), so native input cannot be dispatched. Restore the dedicated browser window (un-minimize it and bring it to the front) and retry.`
      );
    }
  }

  // The page's own visibility state, or null when it cannot be observed.
  private async readPageVisibility(
    endpoint: string,
    signal: AbortSignal
  ): Promise<string | null> {
    try {
      const evaluated = await this.cdpCommand(
        endpoint,
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        AbortSignal.any([signal, AbortSignal.timeout(3000)])
      );
      const value = (evaluated as { result?: { value?: unknown } })?.result
        ?.value;
      return typeof value === "string" ? value : null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  }

  /**
  A cancelled CLI has not emitted close; isolate only its own CDP target.
  */
  quarantine(endpoint: string): void {
    this.quarantined.add(endpoint);
    this.busy.add(endpoint);
  }

  /**
  The CLI has now closed, so its CDP target can be leased again.
  */
  releaseQuarantine(endpoint: string): void {
    this.quarantined.delete(endpoint);
    this.busy.delete(endpoint);
    if (this.visibleLease === endpoint) {
      this.visibleLease = null;
      this.activeForegroundRelease?.();
    }
    this.notify();
  }

  private resetState(): void {
    this.generation += 1;
    this.port = null;
    this.browserWsUrl = null;
    this.slots.clear();
    this.busy.clear();
    this.quarantined.clear();
    this.visibleLease = null;
    this.activeForegroundRelease?.();
    this.creatingTarget = false;
    this.notify();
  }

  /**
  Release the browser without closing it.

  Its windows, tabs and sign-in outlive this owner: a restarted bridge
  adopts them instead of launching a new browser that opens its windows
  again. The operator closes the browser; the next command relaunches it.
  */
  async close(): Promise<void> {
    this.closing = true;
    this.notify();
    await this.starting?.catch(() => undefined);
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
    // A caller must not bypass an in-progress start just because
    // /json/version already answers.
    if (!this.starting) {
      this.starting = this.checkReady().finally(() => {
        this.starting = null;
        this.notify();
      });
    }
    await this.starting;
  }

  private async checkReady(): Promise<void> {
    if (this.port !== null && (await this.version())) return;
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
      throw new OpencliBrowserUnavailableError(EXECUTABLE_MISSING);
    await this.stopChild();
    this.resetState();
    if (this.closing) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser is shutting down"
      );
    }
    mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.profileDirectory, 0o700);
    if (await this.adoptRunningBrowser()) {
      this.lastError = null;
      this.notify();
      return;
    }
    // Launching against a profile another Chromium still holds would only
    // hand a new window to that browser, so adoption must have ruled it out.
    try {
      unlinkSync(path.join(this.profileDirectory, "DevToolsActivePort"));
    } catch {
      /*
      no stale port file
      */
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
      // Its own process group, so the browser survives a bridge restart.
      { stdio: "ignore", detached: true }
    );
    const child = this.child;
    child.unref();
    this.launchError = null;
    child.once("error", (error) => {
      this.launchError = error;
      this.notify();
    });
    child.once("close", () => {
      if (this.child !== child || this.closing) {
        return;
      }

      // The operator quit the browser. That is not a fault: the next command
      // that needs a page starts it again.
      this.child = null;
      this.resetState();
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
          /*
          ActivePort is written asynchronously during startup.
          */
        }
        if (port !== null && Number.isInteger(port) && port > 0) {
          this.port = port;
          // eslint-disable-next-line no-await-in-loop -- the browser is ready once CDP answers.
          if (await this.version()) {
            if (this.closing) {
              throw new Error("dedicated opencli browser is shutting down");
            }
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

  /**
  Attach to a browser a previous bridge started on this private profile.

  The profile's DevToolsActivePort names the port and the browser's own
  WebSocket path; the browser on that port must report the same path, so a
  stale file or an unrelated listener on a reused port is never adopted.
  */
  private async adoptRunningBrowser(): Promise<boolean> {
    let activePort: string;
    try {
      activePort = readFileSync(
        path.join(this.profileDirectory, "DevToolsActivePort"),
        "utf8"
      );
    } catch {
      return false;
    }
    const [portLine, browserPath] = activePort.split(ACTIVE_PORT_LINE_BREAK);
    const port = Number(portLine);
    if (!Number.isSafeInteger(port) || port <= 0 || !browserPath?.trim()) {
      return false;
    }
    this.port = port;
    if (
      (await this.version()) &&
      this.browserWsUrl?.endsWith(browserPath.trim())
    ) {
      return true;
    }
    this.port = null;
    this.browserWsUrl = null;
    return false;
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
    if (child.exitCode !== null) {
      return;
    }

    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      }),
      delay(1000)
    ]);
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

  private async targets(): Promise<CdpTarget[]> {
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
      return (await response.json()) as CdpTarget[];
    } catch (error) {
      throw new OpencliBrowserUnavailableError(
        "dedicated opencli browser returned an invalid target list",
        { cause: error }
      );
    }
  }

  /**
  Every leased endpoint, of every site.
  */
  private slottedTargets(): Set<string> {
    const slotted = new Set<string>();
    for (const endpoints of this.slots.values()) {
      for (const endpoint of endpoints) slotted.add(endpoint);
    }
    return slotted;
  }

  /**
  Find or open one more tab for a site.

  An unclaimed tab already on the site comes first: one the operator opened
  to sign in, or one a previous bridge left. Opening a page goes on to an
  unclaimed blank tab, such as the one Chromium starts with, and only then
  to a new tab in the existing window. Returns null when `shouldOpenPage` is false
  and the site has no unclaimed tab.
  */
  private async findOrOpenSiteTab(
    site: OpencliSite,
    inventory: readonly CdpTarget[],
    shouldOpenPage: boolean
  ): Promise<string | null> {
    const slotted = this.slottedTargets();
    const unclaimed = inventory.filter(
      (target) =>
        (target.type === undefined || target.type === "page") &&
        target.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:") &&
        !slotted.has(target.webSocketDebuggerUrl)
    );
    const siteHost = pageHost(SITE_HOME[site]);
    const sitePage = unclaimed.find(
      (target) => pageHost(target.url) === siteHost
    );
    if (sitePage) return sitePage.webSocketDebuggerUrl;
    if (!shouldOpenPage) return null;
    const blank = unclaimed.find(
      (target) => target.url !== undefined && BLANK_PAGE_URLS.has(target.url)
    );
    if (blank) {
      try {
        await this.cdpCommand(blank.webSocketDebuggerUrl, "Page.navigate", {
          url: SITE_HOME[site]
        });
        return blank.webSocketDebuggerUrl;
      } catch {
        // The blank tab went away or refused; open a new one instead.
      }
    }
    return this.createTab(site);
  }

  private async createTab(site: OpencliSite): Promise<string> {
    const url = SITE_HOME[site];
    if (this.browserWsUrl) {
      try {
        // A tab in the existing window. Chromium opens a window itself only
        // when the browser has none left.
        const created = (await this.cdpCommand(
          this.browserWsUrl,
          "Target.createTarget",
          { url }
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

  /**
  Forget a site's idle tabs the operator closed, and return the rest.

  A tab claimed while the inventory was in flight is missing from that stale
  list but was not `known` before it, so it stays.
  */
  private pruneClosedTabs(
    site: OpencliSite,
    inventory: readonly CdpTarget[],
    known: ReadonlySet<string>
  ): string[] {
    const live = new Set(inventory.map((target) => target.webSocketDebuggerUrl));
    const slots = (this.slots.get(site) ?? []).filter(
      (endpoint) =>
        live.has(endpoint) ||
        !known.has(endpoint) ||
        this.busy.has(endpoint) ||
        this.quarantined.has(endpoint)
    );
    this.slots.set(site, slots);
    return slots;
  }

  private async acquire(
    site: OpencliSite,
    signal: AbortSignal,
    requiresVisiblePage: boolean,
    shouldOpenPage: boolean
  ): Promise<{ endpoint: string; generation: number }> {
    const canLease = (): boolean =>
      !this.closing &&
      !this.creatingTarget &&
      (!requiresVisiblePage || this.visibleLease === null);
    const lease = (
      endpoint: string,
      generation: number
    ): { endpoint: string; generation: number } => {
      this.busy.add(endpoint);
      if (requiresVisiblePage) this.visibleLease = endpoint;
      return { endpoint, generation };
    };
    while (!signal.aborted) {
      const observedRevision = this.changeRevision;
      if (this.closing) {
        throw new OpencliBrowserUnavailableError(
          "dedicated opencli browser is shutting down"
        );
      }
      if (this.starting || this.port === null) {
        // A probe never starts the browser it observes.
        if (!shouldOpenPage) throw new OpencliSitePageNotOpenError(site);
        // Recover transparently if Chromium exited while waiting.
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
      const known = this.slottedTargets();
      // A fresh target list is required to detect tabs closed since the last turn.
      // eslint-disable-next-line no-await-in-loop -- every retry needs a fresh target inventory.
      const inventory = await this.targets();
      if (gen !== this.generation || !canLease()) continue;
      const slots = this.pruneClosedTabs(site, inventory, known);
      const free = slots.find(
        (endpoint) =>
          !this.busy.has(endpoint) && !this.quarantined.has(endpoint)
      );
      if (free) return lease(free, gen);
      // Opening a tab activates it, so none opens while a foreground turn
      // owns native input; re-evaluate after its release.
      if (
        slots.length < this.options.siteTabs[site] &&
        this.visibleLease === null
      ) {
        this.creatingTarget = true;
        let endpoint: string | null;
        try {
          // eslint-disable-next-line no-await-in-loop -- the tab must exist before it is leased.
          endpoint = await this.findOrOpenSiteTab(site, inventory, shouldOpenPage);
        } finally {
          if (gen === this.generation) {
            this.creatingTarget = false;
            this.notify();
          }
        }
        if (gen !== this.generation) continue;
        if (endpoint === null) throw new OpencliSitePageNotOpenError(site);
        const current = this.slots.get(site) ?? [];
        current.push(endpoint);
        this.slots.set(site, current);
        if (canLease() && !signal.aborted) return lease(endpoint, gen);
        continue;
      }
      // Wait for a lease to free without spinning on target list fetches.
      // eslint-disable-next-line no-await-in-loop -- wait for another lease to become free.
      await this.waitForChange(signal, observedRevision);
    }
    throw new Error(
      "opencli browser command cancelled while waiting for a tab"
    );
  }
}
