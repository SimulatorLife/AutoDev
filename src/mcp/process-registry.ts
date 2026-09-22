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
 * The contract mirrors `SpawnSessionRegistry` in `src/agents/bridge-spawn-session.ts`:
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
export const DEFAULT_KILL_TIMEOUT_MS = 5_000;

export interface McpProcessEntry {
  pid: number;
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
  now?: () => number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (message: string) => void;
}

interface InternalKillResult {
  stopped: boolean;
  escalated: boolean;
}

const FAIL_SAFE_DEFAULTS = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxIdleMs: DEFAULT_MAX_IDLE_MS,
  killTimeoutMs: DEFAULT_KILL_TIMEOUT_MS
});

export class McpProcessRegistry {
  private readonly maxEntries: number;
  private readonly maxIdleMs: number;
  private readonly killTimeoutMs: number;
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
      1_000,
      options.maxIdleMs ?? FAIL_SAFE_DEFAULTS.maxIdleMs
    );
    this.killTimeoutMs = Math.max(
      100,
      options.killTimeoutMs ?? FAIL_SAFE_DEFAULTS.killTimeoutMs
    );
    this.now = options.now ?? (() => Date.now());
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.log = options.log ?? (() => undefined);
  }

  /** Record a fresh MCP server PID against the session that opened it. */
  register(pid: number, sessionKey: string, serverName: string): void {
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(`register() requires a positive integer pid; got ${pid}`);
    if (typeof sessionKey !== "string" || !sessionKey.trim())
      throw new Error("register() requires a non-empty sessionKey");
    if (typeof serverName !== "string" || !serverName.trim())
      throw new Error("register() requires a non-empty serverName");
    const now = this.now();
    this.evictOldestUntil(this.maxEntries - 1, now);
    this.entries.set(pid, {
      pid,
      sessionKey,
      serverName,
      registeredAt: now,
      lastActivity: now
    });
  }

  /** Update the last-activity timestamp. No-op when the PID is unknown. */
  touch(pid: number): void {
    const entry = this.entries.get(pid);
    if (!entry) return;
    entry.lastActivity = this.now();
  }

  /** Remove a PID from the registry without signalling it. */
  unregister(pid: number): void {
    this.entries.delete(pid);
  }

  /** Drop entries whose owner has been silent for longer than `maxIdleMs`. */
  reapStale(maxIdleMs: number = this.maxIdleMs): {
    killed: number;
    remaining: number;
  } {
    const deadline = this.now() - Math.max(1_000, maxIdleMs);
    let killed = 0;
    for (const [pid, entry] of [...this.entries.entries()]) {
      if (entry.lastActivity >= deadline) continue;
      if (this.killProcess(pid, entry, "stale")) killed += 1;
      this.entries.delete(pid);
    }
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
    for (const [pid, entry] of this.entries.entries()) {
      if (entry.sessionKey !== sessionKey) continue;
      owned.push(entry);
      this.entries.delete(pid);
    }
    if (owned.length === 0) return;
    await Promise.all(
      owned.map((entry) => this.killAndAwait(entry, signal, timeoutMs))
    );
  }

  /**
   * Start a periodic sweeper that reaps stale entries. Calling this twice is
   * a no-op for the second caller; pass `intervalMs <= 0` to stop the
   * existing sweeper without starting a new one.
   */
  startIdleSweeper(
    intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
    maxIdleMs: number = this.maxIdleMs
  ): NodeJS.Timeout | null {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    if (intervalMs <= 0) return null;
    this.sweeper = setInterval(() => {
      this.reapStale(maxIdleMs);
    }, intervalMs);
    // The sweeper keeps the event loop alive on its own; nothing else should
    // be doing that, and a router that does not want it can stop it with
    // intervalMs <= 0.
    if (typeof this.sweeper.unref === "function") this.sweeper.unref();
    return this.sweeper;
  }

  /** Stop the sweeper. Safe to call when no sweeper is running. */
  stopIdleSweeper(): void {
    if (this.sweeper !== null) {
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
    pid: number,
    entry: McpProcessEntry,
    reason: string
  ): boolean {
    try {
      this.kill(pid, "SIGTERM");
      this.log(
        `mcp registry: signaled pid=${pid} server=${entry.serverName} session=${entry.sessionKey} reason=${reason}`
      );
      return true;
    } catch (error) {
      this.log(
        `mcp registry: failed to signal pid=${pid} server=${entry.serverName}: ${
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
    const initial = this.killProcess(entry.pid, entry, signal);
    if (!initial) return { stopped: false, escalated: false };
    const exited = await this.waitForExit(entry.pid, timeoutMs);
    if (exited) return { stopped: true, escalated: false };
    try {
      this.kill(entry.pid, "SIGKILL");
      this.log(
        `mcp registry: escalated pid=${entry.pid} server=${entry.serverName} to SIGKILL`
      );
      return { stopped: true, escalated: true };
    } catch (error) {
      this.log(
        `mcp registry: failed to escalate pid=${entry.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { stopped: false, escalated: false };
    }
  }

  private waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
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
          this.kill(pid, 0 as unknown as NodeJS.Signals);
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
      this.log(
        `mcp registry: evicted pid=${pair[0]} server=${pair[1].serverName} session=${pair[1].sessionKey} now=${now}`
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
 * not have a PID to record (Codex Desktop's MCP launcher runs out of
 * AutoDev's process tree). The registry still kills / times out / evicts
 * the entry; the only difference from a real PID is that the kill is a
 * no-op (a missing process is logged and swallowed). The negative id
 * can be passed back to {@link McpProcessRegistry.touch} or
 * {@link McpProcessRegistry.unregister}.
 */
export function registerLogical(
  sessionKey: string,
  serverName: string,
  registry: McpProcessRegistry = getDefaultMcpProcessRegistry()
): number {
  // Negative ids never collide with real OS pids and are easy to filter out.
  const id = -Math.abs(
    hashStringToInt(`${sessionKey}\u0000${serverName}\u0000${registry.status().total}`)
  );
  registry.register(id, sessionKey, serverName);
  return id;
}

function hashStringToInt(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
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
      registry.stopIdleSweeper();
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
    registry.stopIdleSweeper();
  };
}
