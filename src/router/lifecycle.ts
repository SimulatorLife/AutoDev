export type RouterLifecycleState = 'ready' | 'draining';

export interface RouterLifecycleStatus {
  state: RouterLifecycleState;
  draining: boolean;
  changedAt: string;
  activeResponseRequests: number;
}

export interface RouterLifecycleOptions {
  startedAt?: string;
  drainTimeoutMs?: number;
  routerInstanceId?: string;
}

export interface ShutdownOptions {
  signal?: string | undefined;
  server?: { close(cb: (err?: Error) => void): void } | null | undefined;
  persistState?: (() => Promise<void>) | undefined;
  drainTimeoutMs?: number | undefined;
  routerInstanceId?: string | undefined;
  noExit?: boolean | undefined;
}

export class RouterLifecycle {
  private lifecycleState: RouterLifecycleState = 'ready';
  private lifecycleStateChangedAt: string;
  private readonly activeRequestAborters = new Set<AbortController>();
  private shutdownPromise: Promise<void> | null = null;
  private readonly defaultDrainTimeoutMs: number;
  private readonly routerInstanceId: string;

  constructor(options: RouterLifecycleOptions = {}) {
    this.lifecycleStateChangedAt = options.startedAt ?? new Date().toISOString();
    this.defaultDrainTimeoutMs = options.drainTimeoutMs ?? Number.parseInt(process.env.CODEX_ROUTER_SHUTDOWN_DRAIN_MS ?? '30000', 10);
    this.routerInstanceId = options.routerInstanceId ?? 'router-lifecycle';
  }

  isDraining(): boolean {
    return this.lifecycleState !== 'ready';
  }

  get state(): RouterLifecycleState {
    return this.lifecycleState;
  }

  get changedAt(): string {
    return this.lifecycleStateChangedAt;
  }

  get activeRequestCount(): number {
    return this.activeRequestAborters.size;
  }

  getLifecycleStatus(): RouterLifecycleStatus {
    return {
      state: this.lifecycleState,
      draining: this.isDraining(),
      changedAt: this.lifecycleStateChangedAt,
      activeResponseRequests: this.activeRequestAborters.size,
    };
  }

  setLifecycleState(next: RouterLifecycleState): void {
    this.lifecycleState = next;
    this.lifecycleStateChangedAt = new Date().toISOString();
  }

  registerActiveRequest(abortController: AbortController | null | undefined): void {
    if (!abortController) return;
    this.activeRequestAborters.add(abortController);
  }

  unregisterActiveRequest(abortController: AbortController | null | undefined): void {
    if (!abortController) return;
    this.activeRequestAborters.delete(abortController);
  }

  abortActiveResponseRequests(): void {
    for (const controller of this.activeRequestAborters.values()) {
      try {
        controller.abort();
      } catch {
        /* best effort during shutdown */
      }
    }
  }

  async beginShutdown(
    optionsOrSignal: ShutdownOptions | string = {},
    server?: { close(cb: (err?: Error) => void): void } | null,
    persistState?: () => Promise<void>
  ): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const options: ShutdownOptions = typeof optionsOrSignal === 'string'
      ? { signal: optionsOrSignal, server, persistState }
      : optionsOrSignal;
    this.setLifecycleState('draining');
    const drainingStartedAt = Date.now();
    const activeAtStart = this.activeRequestAborters.size;
    const drainTimeoutMs = options.drainTimeoutMs ?? this.defaultDrainTimeoutMs;
    const instanceId = options.routerInstanceId ?? this.routerInstanceId;
    const signal = options.signal ?? 'SIGTERM';

    console.error(JSON.stringify({
      schema: 'autodev-router-event-v1',
      timestamp: new Date().toISOString(),
      routerInstanceId: instanceId,
      requestId: null,
      phase: 'shutdown_started',
      signal,
      inFlightRequests: activeAtStart,
      drainTimeoutMs,
    }));

    this.shutdownPromise = (async () => {
      while (this.activeRequestAborters.size > 0 && Date.now() - drainingStartedAt < drainTimeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.activeRequestAborters.size > 0) {
        this.abortActiveResponseRequests();
      }
      if (options.persistState) {
        try {
          await options.persistState();
        } catch {
          /* logging handled by persist callback */
        }
      }
      if (options.server && typeof options.server.close === 'function') {
        try {
          await new Promise<void>((resolve) => options.server!.close(() => resolve()));
        } catch {
          /* best effort server close */
        }
      }
      console.error(JSON.stringify({
        schema: 'autodev-router-event-v1',
        timestamp: new Date().toISOString(),
        routerInstanceId: instanceId,
        requestId: null,
        phase: 'shutdown_complete',
        durationMs: Date.now() - drainingStartedAt,
        abortedInFlight: this.activeRequestAborters.size > 0,
      }));
      const noExit = options.noExit ?? (process.env.CODEX_ROUTER_TEST_NO_EXIT === '1');
      if (!noExit) {
        process.exit(0);
      }
    })();
    return this.shutdownPromise;
  }

  resetLifecycleForTests(): void {
    this.setLifecycleState('ready');
    this.activeRequestAborters.clear();
    this.shutdownPromise = null;
  }
}

let defaultRouterLifecycle: RouterLifecycle | null = null;

export function getDefaultRouterLifecycle(options?: RouterLifecycleOptions): RouterLifecycle {
  if (!defaultRouterLifecycle) {
    defaultRouterLifecycle = new RouterLifecycle(options);
  }
  return defaultRouterLifecycle;
}

export function setDefaultRouterLifecycle(lifecycle: RouterLifecycle | null): void {
  defaultRouterLifecycle = lifecycle;
}

export function isDraining(): boolean {
  return getDefaultRouterLifecycle().isDraining();
}

export function getLifecycleStatus(): RouterLifecycleStatus {
  return getDefaultRouterLifecycle().getLifecycleStatus();
}

export function setLifecycleState(next: RouterLifecycleState): void {
  getDefaultRouterLifecycle().setLifecycleState(next);
}

export function registerActiveRequest(abortController: AbortController | null | undefined): void {
  getDefaultRouterLifecycle().registerActiveRequest(abortController);
}

export function unregisterActiveRequest(abortController: AbortController | null | undefined): void {
  getDefaultRouterLifecycle().unregisterActiveRequest(abortController);
}

export function abortActiveResponseRequests(): void {
  getDefaultRouterLifecycle().abortActiveResponseRequests();
}

export function beginShutdown(
  optionsOrSignal?: ShutdownOptions | string,
  server?: { close(cb: (err?: Error) => void): void } | null,
  persistState?: () => Promise<void>
): Promise<void> {
  return getDefaultRouterLifecycle().beginShutdown(optionsOrSignal, server, persistState);
}

export function resetLifecycleForTests(): void {
  getDefaultRouterLifecycle().resetLifecycleForTests();
}
