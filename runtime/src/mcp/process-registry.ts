/**
 * Bounded registry for long-lived MCP server child processes.
 *
 * Codex Desktop launches its MCP servers out of band -- `lsp-mcp-server`,
 * `cocoindex-code`, `context7`, etc. -- and the lifetime is governed by
 * whatever parent Codex currently has open. If that parent dies before its
 * declared children the orphaned processes keep running, hold ports, and
 * eventually fail a later turn's spawn with `EADDRINUSE`. The fix is to
 * observe every MCP server the router starts on behalf of a Codex session,
 * hold it against the session key, reap any whose owner has not been seen
 * for too long, and hand the rest back to SIGTERM/SIGINT cleanup.
 *
 * The contract mirrors `SpawnSessionRegistry` in `runtime/src/agents/bridge-spawn-session.ts`:
 *
 *   - bounded: at most `maxEntries` children held at once. Older entries are
 *     evicted by last-activity when a new registration would exceed the cap,
 *     which is the fail-safe default when an upper bound is unknown.
 *   - clock-injected: every time-based comparison goes through `now`, so tests
 *     drive the clock deterministically instead of sleeping.
 *   - cleanup is best-effort: a missing process, a permission error, or a
 *     `process.kill` that lands on a reaped pid is logged but never thrown.
 *   - a process the registry cannot identify never gets a kill: callers that
 *     lose their session key pass it explicitly so we know which children
 *     belong to them.
 *
 * Two invariants hold every entry together:
 *
 *   1. A handle is either a process this registry may signal (positive) or a
 *      *logical* handle for a server whose process lives outside AutoDev's
 *      tree (negative -- see {@link registerLogical}). A negative handle is
 *      timed out and counted like any other entry but is never signalled,
 *      because `process.kill(-n)` targets process *group* n.
 *   2. Dropping an entry disposes of what it tracked. Eviction, reaping and
 *      session cleanup all signal before they forget, because the registry
 *      holds the only record: once a handle leaves the map nothing can reach
 *      it again, so a silent drop is an orphan that outlives the registry.
 *
 * Two gaps remain, deliberately left for follow-up rather than half-fixed here:
 *
 *   - `bindProcessRegistryShutdownHooks` has no production caller, so the
 *     SIGTERM/SIGINT path never runs a sweep. It could not work as written
 *     either: it calls `cleanupSession("*")`, which matches by session-key
 *     equality, so the wildcard would select nothing. A cleanup-all needs its
 *     own entry point rather than a sentinel session key.
 *   - `registerLogical` mints a handle as `-Math.abs(hash(...))`, which folds
 *     `+n` and `-n` onto one value, so two exposures can collide and silently
 *     overwrite one another. Losing a logical entry is bookkeeping loss rather
 *     than an orphan (a logical entry owns no process to strand), but it makes
 *     the registry's counts under-report.
 */

/** What signal cleanup forwards by default. SIGTERM is what the router itself receives. */
export const DEFAULT_CLEANUP_SIGNAL: NodeJS.Signals = "SIGTERM";

/** Default reap budget: 30 minutes of inactivity before a process is killed. */
export const DEFAULT_MAX_IDLE_MS = 30 * 60 * 1000;

/** Default sweeper cadence: probe the registry every 5 minutes. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Defence in depth: a runaway Codex Desktop must not leave thousands of MCP servers around. */
export const DEFAULT_MAX_ENTRIES = 512;

/** Per-process kill budget: SIGKILL after 5s if SIGTERM did not reap it. */
export const DEFAULT_KILL_TIMEOUT_MS = 5000;

export interface McpProcessEntry {
  /** Positive for a process this registry may signal; negative for a logical handle. */
  handle: number;
  sessionKey: string;
  serverName: string;
  registeredAt: number;
  lastActivity: number;
}

export interface McpCleanupOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

export interface McpRegistryOptions {
  maxEntries?: number;
  maxIdleMs?: number;
  killTimeoutMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
}

interface InternalKillResult {
  stopped: boolean;
  escalated: boolean;
}

/**
 * Whether this handle names a process the registry may signal.
 *
 * A negative handle is a logical entry ({@link registerLogical}): the server's
 * process was started outside AutoDev's process tree, so the registry bounds
 * and times it out but has no business signalling it. Skipping the kill here
 * is load-bearing rather than cosmetic -- `process.kill(-n, signal)` delivers
 * to process *group* `n`, so an unguarded logical handle would take down an
 * unrelated process group, potentially the router's own.
 */
function isSignalable(handle: number): boolean {
  return handle > 0;
}

const INT32_MODULUS = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;

const FAIL_SAFE_DEFAULTS = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxIdleMs: DEFAULT_MAX_IDLE_MS,
  killTimeoutMs: DEFAULT_KILL_TIMEOUT_MS
});

export class McpProcessRegistry {
  private readonly maxEntries: number;
  private readonly maxIdleMs: number;
  private readonly killTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly log: (message: string) => void;
  private readonly entries = new Map<number, McpProcessEntry>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: McpRegistryOptions = {}) {
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? FAIL_SAFE_DEFAULTS.maxEntries
    );
    this.maxIdleMs = Math.max(
      1000,
      options.maxIdleMs ?? FAIL_SAFE_DEFAULTS.maxIdleMs
    );
    this.killTimeoutMs = Math.max(
      100,
      options.killTimeoutMs ?? FAIL_SAFE_DEFAULTS.killTimeoutMs
    );
    this.sweepIntervalMs = Math.max(
      0,
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    );
    this.now = options.now ?? (() => Date.now());
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.log = options.log ?? (() => undefined);
  }

  /** Record a fresh MCP server against the session that opened it. */
  register(handle: number, sessionKey: string, serverName: string): void {
    if (!Number.isInteger(handle) || handle === 0)
      throw new Error(
        `register() requires a non-zero integer handle (positive pid or negative logical handle); got ${handle}`
      );
    if (typeof sessionKey !== "string" || !sessionKey.trim())
      throw new Error("register() requires a non-empty sessionKey");
    if (typeof serverName !== "string" || !serverName.trim())
      throw new Error("register() requires a non-empty serverName");
    const now = this.now();
    this.evictOldestUntil(this.maxEntries - 1, now);
    this.entries.set(handle, {
      handle,
      sessionKey,
      serverName,
      registeredAt: now,
      lastActivity: now
    });
    this.startSweeperWhenNeeded();
  }

  /** Update the last-activity timestamp. No-op when the handle is unknown. */
  touch(handle: number): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    entry.lastActivity = this.now();
  }

  /** Remove a handle from the registry without signalling it. */
  unregister(handle: number): void {
    this.entries.delete(handle);
    this.stopSweeperWhenIdle();
  }

  /** Drop entries whose owner has been silent for longer than `maxIdleMs`. */
  reapStale(maxIdleMs: number = this.maxIdleMs): {
    killed: number;
    remaining: number;
  } {
    const deadline = this.now() - Math.max(1000, maxIdleMs);
    let killed = 0;
    for (const [handle, entry] of this.entries.entries()) {
      if (entry.lastActivity >= deadline) continue;
      if (this.killProcess(handle, entry, "stale")) killed += 1;
      this.entries.delete(handle);
    }
    this.stopSweeperWhenIdle();
    return { killed, remaining: this.entries.size };
  }

  /**
   * Send every process owned by `sessionKey` a signal, escalate to SIGKILL
   * if it has not exited within `timeoutMs`, then drop the entries.
   */
  async cleanupSession(
    sessionKey: string,
    options: McpCleanupOptions = {}
  ): Promise<void> {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) return;
    const signal = options.signal ?? DEFAULT_CLEANUP_SIGNAL;
    const timeoutMs = Math.max(100, options.timeoutMs ?? this.killTimeoutMs);
    const owned: McpProcessEntry[] = [];
    for (const [handle, entry] of this.entries.entries()) {
      if (entry.sessionKey !== sessionKey) continue;
      owned.push(entry);
      this.entries.delete(handle);
    }
    this.stopSweeperWhenIdle();
    if (owned.length === 0) return;
    await Promise.all(
      owned.map((entry) => this.killAndAwait(entry, signal, timeoutMs))
    );
  }

  private startSweeperWhenNeeded(): void {
    if (this.sweeper !== null || this.sweepIntervalMs === 0) return;
    this.sweeper = setInterval(() => {
      this.reapStale();
    }, this.sweepIntervalMs);
    this.sweeper.unref();
  }

  private stopSweeperWhenIdle(): void {
    if (this.entries.size === 0 && this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  /** Small enough to expose on `/health` without leaking process identifiers. */
  status(): {
    total: number;
    byServer: Record<string, number>;
    bySession: Record<string, number>;
  } {
    const byServer: Record<string, number> = {};
    const bySession: Record<string, number> = {};
    for (const entry of this.entries.values()) {
      byServer[entry.serverName] = (byServer[entry.serverName] ?? 0) + 1;
      bySession[entry.sessionKey] = (bySession[entry.sessionKey] ?? 0) + 1;
    }
    return { total: this.entries.size, byServer, bySession };
  }

  private killProcess(
    handle: number,
    entry: McpProcessEntry,
    reason: string
  ): boolean {
    if (!isSignalable(handle)) {
      this.log(
        `mcp registry: timed out logical handle=${handle} server=${entry.serverName} session=${entry.sessionKey} reason=${reason} (its process is not ours to signal)`
      );
      return false;
    }
    try {
      this.kill(handle, "SIGTERM");
      this.log(
        `mcp registry: signaled pid=${handle} server=${entry.serverName} session=${entry.sessionKey} reason=${reason}`
      );
      return true;
    } catch (error) {
      this.log(
        `mcp registry: failed to signal pid=${handle} server=${entry.serverName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }

  private async killAndAwait(
    entry: McpProcessEntry,
    signal: NodeJS.Signals,
    timeoutMs: number
  ): Promise<InternalKillResult> {
    const initial = this.killProcess(entry.handle, entry, signal);
    if (!initial) return { stopped: false, escalated: false };
    const exited = await this.waitForExit(entry.handle, timeoutMs);
    if (exited) return { stopped: true, escalated: false };
    try {
      this.kill(entry.handle, "SIGKILL");
      this.log(
        `mcp registry: escalated pid=${entry.handle} server=${entry.serverName} to SIGKILL`
      );
      return { stopped: true, escalated: true };
    } catch (error) {
      this.log(
        `mcp registry: failed to escalate pid=${entry.handle} server=${entry.serverName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { stopped: false, escalated: false };
    }
  }

  private waitForExit(handle: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let probeTimer: NodeJS.Timeout | null = null;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (probeTimer !== null) clearTimeout(probeTimer);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const probe = () => {
        if (settled) return;
        try {
          this.kill(handle, 0 as unknown as NodeJS.Signals);
        } catch (error) {
          const code = (error as { code?: string } | null)?.code;
          if (code === "ESRCH") {
            finish(true);
            return;
          }
        }
        probeTimer = setTimeout(probe, 50);
        if (typeof probeTimer.unref === "function") probeTimer.unref();
      };
      probe();
    });
  }

  private evictOldestUntil(target: number, now: number): void {
    if (this.entries.size <= target) return;
    const surplus = this.entries.size - target;
    const sorted = [...this.entries.entries()].sort(
      (a, b) => a[1].lastActivity - b[1].lastActivity
    );
    for (let index = 0; index < surplus; index += 1) {
      const pair = sorted[index];
      if (!pair) break;
      this.entries.delete(pair[0]);
      // Dispose of what the entry tracked before forgetting it. This map is the
      // only record of the handle, so a silent drop would strand the process:
      // no sweeper, no session cleanup and no shutdown hook could ever reach
      // it again, which defeats the cap the eviction exists to enforce.
      this.killProcess(pair[0], pair[1], "evicted");
      this.log(
        `mcp registry: evicted handle=${pair[0]} server=${pair[1].serverName} session=${pair[1].sessionKey} now=${now}`
      );
    }
  }
}

let defaultRegistry: McpProcessRegistry | null = null;

/** Process-wide singleton. The router binds its cleanup hooks to this. */
export function getDefaultMcpProcessRegistry(): McpProcessRegistry {
  if (defaultRegistry === null) defaultRegistry = new McpProcessRegistry();
  return defaultRegistry;
}

/** Test-only: replace the singleton. Returns the previous registry. */
export function setDefaultMcpProcessRegistry(
  registry: McpProcessRegistry | null
): McpProcessRegistry | null {
  const previous = defaultRegistry;
  defaultRegistry = registry;
  return previous;
}

/**
 * Bind SIGTERM/SIGINT cleanup to the default registry. Idempotent: each call
 * returns the same teardown function the caller can pass to its own shutdown
 * chain. The router wires this into its existing shutdown hooks so a server
 * that receives SIGTERM will also kill every MCP child it tracked.
 */

/**
 * Track that `sessionKey` owns an MCP server named `serverName` without
 * claiming a process id. Used by callers that own the lifecycle but do
 * not have a pid to record (Codex Desktop's MCP launcher runs out of
 * AutoDev's process tree). The registry still times out / counts / evicts
 * the entry; the only difference from a real pid is that signalling is a
 * no-op, because the process is not ours to kill. The returned handle can
 * be passed back to {@link McpProcessRegistry.touch} or
 * {@link McpProcessRegistry.unregister}.
 */
export function registerLogical(
  sessionKey: string,
  serverName: string,
  registry: McpProcessRegistry = getDefaultMcpProcessRegistry()
): number {
  // Negative handles never collide with real OS pids, are easy to filter out,
  // and are what keeps them out of `process.kill`. The registry size is folded
  // in so repeated exposures of the same server mint a distinct handle rather
  // than refreshing one entry in place.
  const handle = -Math.abs(
    hashStringToInt(
      `${sessionKey}\u0000${serverName}\u0000${registry.status().total}`
    )
  );
  registry.register(handle, sessionKey, serverName);
  return handle;
}

function signedInt32(value: number): number {
  const unsigned =
    ((Math.trunc(value) % INT32_MODULUS) + INT32_MODULUS) % INT32_MODULUS;
  return unsigned >= INT32_SIGN_BIT ? unsigned - INT32_MODULUS : unsigned;
}

function hashStringToInt(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = signedInt32(Math.imul(hash, 33) + value.charCodeAt(i));
  }
  return hash || 1;
}

export function bindProcessRegistryShutdownHooks(
  registry: McpProcessRegistry = getDefaultMcpProcessRegistry(),
  targets: NodeJS.Signals[] = ["SIGTERM", "SIGINT"]
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of targets) {
    const handler = () => {
      // Best-effort: we do not block shutdown on the cleanup itself; the
      // call's promise resolves quickly because every PID it owns has already
      // been deleted from the map and the kill is fire-and-forget.
      void registry.cleanupSession("*", { signal });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers.entries()) {
      process.off(signal, handler);
    }
  };
}
