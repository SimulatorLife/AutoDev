import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgentActivityTracker } from '../agents/agent-activity.ts';

export type AgentActivityTracker = ReturnType<typeof createAgentActivityTracker>;

export const PROCESS_FALLBACK_SESSION_KEY = 'process-scope';
export const SUBAGENT_SLOT_KIND = 'subagent_slot';

export interface ConcurrencyConfig {
  file: string;
  maxConcurrentThreadsPerSession: number | null;
}

export interface ConcurrencyDenialRecord {
  timestamp: string;
  reason: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export interface ConcurrencyTelemetry {
  denials: number;
  denialsByReason: Record<string, number>;
  lastDenial: ConcurrencyDenialRecord | null;
}

export interface ConcurrencyStatus {
  scope: string;
  configSource: string;
  configFileExists: boolean;
  maxConcurrentThreadsPerSession: number | null;
  effectivePerSessionLimit: number | null;
  activeSubagentThreads: number;
  activeSessions: number;
  processFallbackActiveThreads: number;
  processFallbackEnforcement: boolean;
  denials: number;
  denialsByReason: Record<string, number>;
  lastDenial: ConcurrencyDenialRecord | null;
}

export interface ConcurrencyManagerOptions {
  agentActivity: AgentActivityTracker;
  configFile?: string;
  configSource?: string;
  initialConfig?: ConcurrencyConfig;
}

export function defaultCodexConfigFile(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${codexHome}/config.toml`;
}

export function matchAgentsContext(source: string): string {
  // Multiline `[agents]` table: capture every line up to the next `[section]`
  // header or end of input. Anchored on `[agents]` rather than a key prefix so
  // a misindented file cannot accidentally capture siblings like
  // `[agents.explorer]`. `(?![\s\S])` is the JS idiom for end-of-string,
  // which the engine satisfies whether or not the multiline flag is set;
  // using `$` here would match every line end and truncate the capture at the
  // first newline.
  const multiline = source.match(/^\s*\[agents\]\s*(?:\r?\n|;)([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m);
  if (multiline) return multiline[1] ?? '';
  // Composer-emitted inline table. We hand-roll brace tracking rather than
  // `[^{}]` because the composer inlines every registered role as
  // `agents = { ..., explorer = { ... }, worker = { ... }, ... }` and the
  // naive character class would stop at the first nested role's `{` and
  // miss `max_concurrent_threads_per_session` declared above it.
  const start = source.search(/(?:^|\n)\s*agents\s*=\s*\{/);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

export function parseConcurrencyConfig(file = defaultCodexConfigFile()): ConcurrencyConfig {
  const result: ConcurrencyConfig = { file, maxConcurrentThreadsPerSession: null };
  if (!existsSync(file)) return result;
  try {
    const source = readFileSync(file, 'utf8');
    const agentsContext = matchAgentsContext(source);
    const keyMatch = agentsContext.match(/(?:^|[\s,])max_concurrent_threads_per_session\s*=\s*(\d+)/);
    if (keyMatch && keyMatch[1] !== undefined) {
      result.maxConcurrentThreadsPerSession = Number.parseInt(keyMatch[1], 10);
    }
  } catch (error) {
    console.error(`Warning: could not read Codex concurrency config from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

export class ConcurrencyManager {
  private readonly agentActivity: AgentActivityTracker;
  private readonly config: ConcurrencyConfig;
  private readonly configSource: string;
  private readonly openSubagentSlots = new Map<string, string[]>();
  private subagentSlotSequence = 0;
  public readonly telemetry: ConcurrencyTelemetry = {
    denials: 0,
    denialsByReason: {},
    lastDenial: null,
  };

  constructor(options: ConcurrencyManagerOptions) {
    this.agentActivity = options.agentActivity;
    this.config = options.initialConfig ?? parseConcurrencyConfig(options.configFile);
    this.configSource = options.configSource ?? (process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ? 'env_override' : 'default_codex_home');
  }

  get configFile(): string {
    return this.config.file;
  }

  effectivePerSessionLimit(): number | null {
    return this.config.maxConcurrentThreadsPerSession;
  }

  activeSubagentThreads(at?: number): number {
    return this.agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND }, at);
  }

  tryAcquireSubagentSlot(sessionKey: string): string | null {
    const sessionActive = this.agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND, tag: sessionKey });
    const perSessionLimit = this.effectivePerSessionLimit();
    if (perSessionLimit !== null && sessionActive >= perSessionLimit) {
      return 'max_concurrent_threads_per_session';
    }
    this.subagentSlotSequence += 1;
    const subject = `${SUBAGENT_SLOT_KIND}:${sessionKey}:${this.subagentSlotSequence}`;
    this.agentActivity.beginRequest(subject, {
      requestId: subject,
      kind: SUBAGENT_SLOT_KIND,
      tag: sessionKey,
      origin: 'subagent',
    });
    const stack = this.openSubagentSlots.get(sessionKey) ?? [];
    stack.push(subject);
    this.openSubagentSlots.set(sessionKey, stack);
    return null;
  }

  releaseSubagentSlot(sessionKey: string): void {
    const stack = this.openSubagentSlots.get(sessionKey);
    if (!stack || stack.length === 0) return;
    const subject = stack.pop()!;
    if (stack.length === 0) this.openSubagentSlots.delete(sessionKey);
    this.agentActivity.finish(subject, { requestId: subject, outcome: 'success' });
  }

  touchOpenSubagentSlots(sessionKey: string): void {
    const stack = this.openSubagentSlots.get(sessionKey);
    if (!stack) return;
    for (const subject of stack) {
      this.agentActivity.touch(subject);
    }
  }

  recordConcurrencyDenial(input: string | ConcurrencyDenialRecord, at: number | string = new Date().toISOString()): void {
    const reason = typeof input === 'string' ? input : (input.reason ?? 'unknown');
    this.telemetry.denials += 1;
    this.telemetry.denialsByReason[reason] = (this.telemetry.denialsByReason[reason] ?? 0) + 1;
    if (typeof input === 'object' && input !== null) {
      const timestamp = typeof at === 'number' ? new Date(at).toISOString() : (input.timestamp ?? at);
      this.telemetry.lastDenial = {
        ...input,
        timestamp,
        reason,
      };
    } else {
      this.telemetry.lastDenial = {
        timestamp: typeof at === 'number' ? new Date(at).toISOString() : at,
        reason,
      };
    }
  }

  resetConcurrencyTelemetry(): void {
    this.openSubagentSlots.clear();
    this.agentActivity.reset();
    this.telemetry.denials = 0;
    this.telemetry.denialsByReason = {};
    this.telemetry.lastDenial = null;
  }

  restoreTelemetry(saved?: Partial<ConcurrencyTelemetry> | null): void {
    if (!saved || typeof saved !== 'object') return;
    if (Number.isInteger(saved.denials) && (saved.denials as number) >= 0) {
      this.telemetry.denials = saved.denials as number;
    }
    if (saved.denialsByReason && typeof saved.denialsByReason === 'object') {
      this.telemetry.denialsByReason = { ...saved.denialsByReason };
    }
    if (saved.lastDenial === null || (saved.lastDenial && typeof saved.lastDenial === 'object')) {
      this.telemetry.lastDenial = saved.lastDenial;
    }
  }

  concurrencyStatus(at = Date.now()): ConcurrencyStatus {
    const processFallbackActiveThreads = this.agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY }, at);
    return {
      scope: 'router-admitted-child-requests',
      configSource: this.configSource,
      configFileExists: existsSync(this.config.file),
      maxConcurrentThreadsPerSession: this.effectivePerSessionLimit(),
      effectivePerSessionLimit: this.effectivePerSessionLimit(),
      activeSubagentThreads: this.agentActivity.countLive({ kind: SUBAGENT_SLOT_KIND }, at),
      activeSessions: this.agentActivity.distinctTags({ kind: SUBAGENT_SLOT_KIND }, at).length,
      processFallbackActiveThreads,
      processFallbackEnforcement: processFallbackActiveThreads > 0,
      denials: this.telemetry.denials,
      denialsByReason: { ...this.telemetry.denialsByReason },
      lastDenial: this.telemetry.lastDenial,
    };
  }
}

let defaultConcurrencyManager: ConcurrencyManager | null = null;

export function getDefaultConcurrencyManager(): ConcurrencyManager {
  if (!defaultConcurrencyManager) {
    defaultConcurrencyManager = new ConcurrencyManager({
      agentActivity: createAgentActivityTracker(),
    });
  }
  return defaultConcurrencyManager;
}

export function setDefaultConcurrencyManager(manager: ConcurrencyManager | null): void {
  defaultConcurrencyManager = manager;
}

export function effectivePerSessionLimit(): number | null {
  return getDefaultConcurrencyManager().effectivePerSessionLimit();
}

export function activeSubagentThreads(at?: number): number {
  return getDefaultConcurrencyManager().activeSubagentThreads(at);
}

export function tryAcquireSubagentSlot(sessionKey: string): string | null {
  return getDefaultConcurrencyManager().tryAcquireSubagentSlot(sessionKey);
}

export function releaseSubagentSlot(sessionKey: string): void {
  getDefaultConcurrencyManager().releaseSubagentSlot(sessionKey);
}

export function touchOpenSubagentSlots(sessionKey: string): void {
  getDefaultConcurrencyManager().touchOpenSubagentSlots(sessionKey);
}

export function recordConcurrencyDenial(input: string | ConcurrencyDenialRecord, at?: number | string): void {
  getDefaultConcurrencyManager().recordConcurrencyDenial(input, at);
}

export function resetConcurrencyTelemetry(): void {
  getDefaultConcurrencyManager().resetConcurrencyTelemetry();
}

export function restoreConcurrencyTelemetry(saved?: Partial<ConcurrencyTelemetry> | null): void {
  getDefaultConcurrencyManager().restoreTelemetry(saved);
}

export function concurrencyStatus(at = Date.now()): ConcurrencyStatus {
  return getDefaultConcurrencyManager().concurrencyStatus(at);
}
