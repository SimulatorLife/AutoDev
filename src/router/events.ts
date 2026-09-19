export type ProviderFailureClass =
  | 'session_limit'
  | 'quota_exhausted'
  | 'throttled'
  | 'capacity'
  | 'timeout'
  | 'unavailable'
  | 'invalid_model'
  | 'authentication'
  | 'upstream_error'
  | 'request_error';

export interface WorkspaceInput {
  key?: string | null | undefined;
  cwd?: string | null | undefined;
  [key: string]: unknown;
}

export interface RouterEvent {
  schema: 'autodev-router-event-v1';
  timestamp: string;
  routerInstanceId: string;
  requestId: string | null;
  /** The Codex thread the request came from, when the caller named one. */
  thread: string | null;
  phase: string;
  role: string | null;
  requestedModel: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  workspace: string | null;
  cwd: string | null;
  outcome: string | null;
  status: number | null;
  failureClass: string | null;
  denialReason: string | null;
  spawnFailureReason: string | null;
  elapsedMs: number | null;
  toolCalls: number;
  errorName: string | null;
  errorCode: string | null;
  syscall: string | null;
  selection: string | null;
  normalizedItemIds: number;
  droppedReasoningItems: number;
}

export interface RecordRouterEventInput {
  phase: string;
  requestId?: string | null | undefined;
  thread?: string | null | undefined;
  role?: string | null | undefined;
  requestedModel?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  workspace?: string | WorkspaceInput | null | undefined;
  cwd?: string | null | undefined;
  outcome?: string | null | undefined;
  status?: number | null | undefined;
  failureClass?: string | null | undefined;
  denialReason?: string | null | undefined;
  spawnFailureReason?: string | null | undefined;
  elapsedMs?: number | null | undefined;
  toolCalls?: number | undefined;
  errorName?: string | null | undefined;
  errorCode?: string | null | undefined;
  syscall?: string | null | undefined;
  origin?: string | null | undefined;
  selection?: string | null | undefined;
  normalizedItemIds?: number | undefined;
  droppedReasoningItems?: number | undefined;
}

export function classifyProviderFailure(status: number, body: unknown = ''): ProviderFailureClass {
  const text = String(body ?? '');
  if (/session.?limit|session.*(?:exhaust|capacity)|concurrent session/i.test(text)) return 'session_limit';
  if (/quota|credit|billing|usage.?limit|usage exhausted|insufficient.*(?:fund|quota)/i.test(text)) return 'quota_exhausted';
  if (status === 429 || /rate.?limit|weekly.?limit|throttl|too many requests/i.test(text)) return 'throttled';
  if (/high.?demand|overloaded|capacity/i.test(text)) return 'capacity';
  if (status === 408 || /timeout|timed.?out/i.test(text)) return 'timeout';
  if ([502, 503, 504].includes(status) || /temporarily unavailable|unavailable/i.test(text)) return 'unavailable';
  if (/invalid model|model name.*(?:invalid|not found)|unknown model/i.test(text)) return 'invalid_model';
  if ([401, 403].includes(status)) return 'authentication';
  if (typeof status === 'number' && status >= 500) return 'upstream_error';
  return 'request_error';
}

export interface RouterEventRecorderOptions {
  maxRecentEvents?: number | undefined;
  routerInstanceId?: string | undefined;
  logger?: ((event: RouterEvent) => void) | null | undefined;
  resolveOrigin?: ((role: string | null | undefined, provider: string | null | undefined) => string | null | undefined) | undefined;
  onEvent?: ((event: RouterEvent, input: RecordRouterEventInput, effectiveOrigin: string | null) => void) | undefined;
}

export class RouterEventRecorder {
  private readonly recentEvents: RouterEvent[] = [];
  // Which thread each in-flight request belongs to. The many call sites that
  // record a request's events know its id, not its thread, so the thread is
  // noted once when the request arrives. Bounded, oldest first.
  private readonly requestThreads = new Map<string, string>();
  private readonly maxRecentEvents: number;
  private readonly routerInstanceId: string;
  private readonly logger: ((event: RouterEvent) => void) | null;
  private readonly resolveOrigin?: ((role: string | null | undefined, provider: string | null | undefined) => string | null | undefined) | undefined;
  private readonly onEventListener?: ((event: RouterEvent, input: RecordRouterEventInput, effectiveOrigin: string | null) => void) | undefined;

  constructor(options: RouterEventRecorderOptions = {}) {
    const rawMax = options.maxRecentEvents ?? Number.parseInt(process.env.CODEX_ROUTER_MAX_RECENT_EVENTS ?? '100', 10);
    this.maxRecentEvents = Math.max(1, Number.isFinite(rawMax) ? rawMax : 100);
    this.routerInstanceId = options.routerInstanceId ?? 'router-event-recorder';
    this.logger = options.logger === undefined ? (event) => console.error(JSON.stringify(event)) : options.logger;
    this.resolveOrigin = options.resolveOrigin;
    this.onEventListener = options.onEvent;
  }

  get length(): number {
    return this.recentEvents.length;
  }

  getRecentEvents(reversed = false): RouterEvent[] {
    return reversed ? [...this.recentEvents].reverse() : [...this.recentEvents];
  }

  clear(): void {
    this.recentEvents.length = 0;
  }

  restore(events: unknown[]): void {
    this.clear();
    if (!Array.isArray(events)) return;
    const valid = events.filter((e): e is RouterEvent => e !== null && typeof e === 'object');
    this.recentEvents.push(...valid.slice(-this.maxRecentEvents));
  }

  noteRequestThread(requestId: string, thread: string | null): void {
    if (!thread) return;
    this.requestThreads.set(requestId, thread);
    while (this.requestThreads.size > 4096) {
      const oldest = this.requestThreads.keys().next().value;
      if (oldest === undefined) break;
      this.requestThreads.delete(oldest);
    }
  }

  record(input: RecordRouterEventInput): RouterEvent {
    const timestamp = new Date().toISOString();
    const rawWorkspace = input.workspace;
    let workspaceKey: string | null = null;
    let cwd: string | null = input.cwd ?? null;

    if (typeof rawWorkspace === 'string') {
      workspaceKey = rawWorkspace;
    } else if (rawWorkspace && typeof rawWorkspace === 'object') {
      workspaceKey = rawWorkspace.key ?? null;
      cwd = (rawWorkspace.cwd as string | undefined) ?? cwd;
    }

    const effectiveOrigin = input.origin ?? (this.resolveOrigin ? this.resolveOrigin(input.role, input.provider) : null) ?? null;
    const effectiveRole = input.role ?? (effectiveOrigin === 'orchestrator' ? 'orchestrator' : null);

    const event: RouterEvent = {
      schema: 'autodev-router-event-v1',
      timestamp,
      routerInstanceId: this.routerInstanceId,
      requestId: input.requestId ?? null,
      thread: input.thread ?? (input.requestId ? this.requestThreads.get(input.requestId) ?? null : null),
      phase: input.phase,
      role: effectiveRole,
      requestedModel: input.requestedModel,
      provider: input.provider,
      model: input.model,
      workspace: workspaceKey,
      cwd,
      outcome: input.outcome ?? null,
      status: input.status ?? null,
      failureClass: input.failureClass ?? null,
      denialReason: input.denialReason ?? null,
      spawnFailureReason: input.spawnFailureReason ?? null,
      elapsedMs: input.elapsedMs ?? null,
      toolCalls: input.toolCalls ?? 0,
      errorName: input.errorName ?? null,
      errorCode: input.errorCode ?? null,
      syscall: input.syscall ?? null,
      selection: input.selection ?? null,
      normalizedItemIds: input.normalizedItemIds ?? 0,
      droppedReasoningItems: input.droppedReasoningItems ?? 0,
    };

    this.recentEvents.push(event);
    while (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    if (this.onEventListener) {
      try {
        this.onEventListener(event, input, effectiveOrigin);
      } catch (err) {
        console.error('Error in onEvent listener:', err);
      }
    }

    if (this.logger) {
      try {
        this.logger(event);
      } catch {
        /* best effort logging */
      }
    }

    return event;
  }
}

let defaultRouterEventRecorder: RouterEventRecorder | null = null;

export function getDefaultRouterEventRecorder(): RouterEventRecorder {
  if (!defaultRouterEventRecorder) {
    defaultRouterEventRecorder = new RouterEventRecorder();
  }
  return defaultRouterEventRecorder;
}

export function setDefaultRouterEventRecorder(recorder: RouterEventRecorder | null): void {
  defaultRouterEventRecorder = recorder;
}

export function recordRouterEvent(input: RecordRouterEventInput): RouterEvent {
  return getDefaultRouterEventRecorder().record(input);
}

/** Attribute every later event of this request to the Codex thread that sent it. */
export function noteRequestThread(requestId: string, thread: string | null): void {
  getDefaultRouterEventRecorder().noteRequestThread(requestId, thread);
}

export function getRecentRouterEvents(reversed = false): RouterEvent[] {
  return getDefaultRouterEventRecorder().getRecentEvents(reversed);
}

export function resetRouterEvents(): void {
  getDefaultRouterEventRecorder().clear();
}

export function restoreRecentRouterEvents(events: unknown[]): void {
  getDefaultRouterEventRecorder().restore(events);
}
