import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createAgentActivityTracker } from "../agents/agent-activity.ts";
import { writeErrorLine } from "../shared/output.ts";

export type AgentActivityTracker = ReturnType<
  typeof createAgentActivityTracker
>;

export const PROCESS_FALLBACK_SESSION_KEY = "process-scope";
export const SUBAGENT_SLOT_KIND = "subagent_slot";

export interface ConcurrencyConfig {
  file: string;
  maxConcurrentThreadsPerSession: number | null;
}

export interface ConcurrencyDenialRecord {
  timestamp?: string;
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
  getOrchestratorSession?: (sessionKey: string) => {
    provider?: string | null;
    model?: string | null;
    workspace?: string | null;
  } | null;
}

export function defaultCodexConfigFile(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return (
    process.env.CODEX_ROUTER_CODEX_CONFIG_FILE ?? `${codexHome}/config.toml`
  );
}

const AGENTS_TABLE_HEADER = /^[^\S\n\r\u2028\u2029]*\[agents\]/gm;
const WHITESPACE_CHAR = /\s/;
const INLINE_AGENTS_TABLE = /(?:^|\n)\s*agents\s*=\s*\{/;
const MAX_CONCURRENT_THREADS_KEY =
  /(?:^|[\s,])max_concurrent_threads_per_session\s*=\s*(\d+)/;

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && WHITESPACE_CHAR.test(source[index] ?? ""))
    index += 1;
  return index;
}

/**
 * Where an `[agents]` header's body begins: after optional whitespace the
 * header must be followed by `;` or a line break. When the whitespace run
 * spans several lines the body starts after its last line break.
 */
function tableBodyStart(source: string, headerEnd: number): number | null {
  const firstContent = skipWhitespace(source, headerEnd);
  if (source[firstContent] === ";") return firstContent + 1;
  const lastBreak = source.lastIndexOf("\n", firstContent - 1);
  return lastBreak >= headerEnd ? lastBreak + 1 : null;
}

/** The first line at or after `from` whose first non-blank character opens a `[section]`. */
// Line terminators recognised by a multiline-mode `^`.
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

function isLineStart(source: string, index: number): boolean {
  return index === 0 || LINE_TERMINATORS.has(source[index - 1] ?? "");
}

function nextLineStart(source: string, from: number): number | null {
  for (let index = from; index < source.length; index += 1)
    if (LINE_TERMINATORS.has(source[index] ?? "")) return index + 1;
  return null;
}

/** The first line at or after `from` whose first non-blank character opens a `[section]`. */
function tableBodyEnd(source: string, from: number): number {
  let lineStart: number | null = isLineStart(source, from)
    ? from
    : nextLineStart(source, from);
  while (lineStart !== null && lineStart < source.length) {
    const firstContent = skipWhitespace(source, lineStart);
    if (firstContent >= source.length) return source.length;
    if (source[firstContent] === "[") return lineStart;
    lineStart = nextLineStart(source, firstContent);
  }
  return source.length;
}

export function matchAgentsContext(source: string): string {
  // Multiline `[agents]` table: capture every line up to the next `[section]`
  // header or end of input. Anchored on `[agents]` rather than a key prefix so
  // a misindented file cannot accidentally capture siblings like
  // `[agents.explorer]`. Scanned linearly rather than with a lazy regex so a
  // large config cannot trigger polynomial backtracking.
  for (const header of source.matchAll(AGENTS_TABLE_HEADER)) {
    const bodyStart = tableBodyStart(source, header.index + header[0].length);
    if (bodyStart !== null)
      return source.slice(bodyStart, tableBodyEnd(source, bodyStart));
  }
  // Composer-emitted inline table. We hand-roll brace tracking rather than
  // `[^{}]` because the composer inlines every registered role as
  // `agents = { ..., explorer = { ... }, worker = { ... }, ... }` and the
  // naive character class would stop at the first nested role's `{` and
  // miss `max_concurrent_threads_per_session` declared above it.
  const start = source.search(INLINE_AGENTS_TABLE);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

export function parseConcurrencyConfig(
  file = defaultCodexConfigFile()
): ConcurrencyConfig {
  const result: ConcurrencyConfig = {
    file,
    maxConcurrentThreadsPerSession: null
  };
  if (!existsSync(file)) return result;
  try {
    const source = readFileSync(file, "utf8");
    const agentsContext = matchAgentsContext(source);
    const keyMatch = agentsContext.match(MAX_CONCURRENT_THREADS_KEY);
    if (keyMatch && keyMatch[1] !== undefined) {
      result.maxConcurrentThreadsPerSession = Number.parseInt(keyMatch[1]);
    }
  } catch (error) {
    writeErrorLine(
      `Warning: could not read Codex concurrency config from ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return result;
}

export class ConcurrencyManager {
  private readonly agentActivity: AgentActivityTracker;
  private readonly config: ConcurrencyConfig;
  private readonly configSource: string;
  private readonly getOrchestratorSession?:
    | ((sessionKey: string) => {
        provider?: string | null;
        model?: string | null;
        workspace?: string | null;
      } | null)
    | undefined;
  private readonly openSubagentSlots = new Map<string, string[]>();
  private subagentSlotSequence = 0;
  public readonly telemetry: ConcurrencyTelemetry = {
    denials: 0,
    denialsByReason: {},
    lastDenial: null
  };

  constructor(options: ConcurrencyManagerOptions) {
    this.agentActivity = options.agentActivity;
    this.config =
      options.initialConfig ?? parseConcurrencyConfig(options.configFile);
    this.configSource =
      options.configSource ??
      (process.env.CODEX_ROUTER_CODEX_CONFIG_FILE
        ? "env_override"
        : "default_codex_home");
    this.getOrchestratorSession = options.getOrchestratorSession;
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
    const sessionActive = this.agentActivity.countLive({
      kind: SUBAGENT_SLOT_KIND,
      tag: sessionKey
    });
    const perSessionLimit = this.effectivePerSessionLimit();
    if (perSessionLimit !== null && sessionActive >= perSessionLimit) {
      return "max_concurrent_threads_per_session";
    }
    this.subagentSlotSequence += 1;
    const subject = `${SUBAGENT_SLOT_KIND}:${sessionKey}:${this.subagentSlotSequence}`;
    this.agentActivity.beginRequest(subject, {
      requestId: subject,
      kind: SUBAGENT_SLOT_KIND,
      tag: sessionKey,
      origin: "subagent"
    });
    const orch = this.getOrchestratorSession?.(sessionKey);
    if (orch) {
      this.agentActivity.noteSubagentWait(sessionKey, {
        provider: orch.provider ?? null,
        model: orch.model ?? null,
        workspace: orch.workspace ?? null,
        role: "orchestrator"
      });
    }
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
    this.agentActivity.finish(subject, {
      requestId: subject,
      outcome: "success"
    });
    const remaining = this.openSubagentSlots.get(sessionKey)?.length ?? 0;
    if (remaining === 0 && this.getOrchestratorSession?.(sessionKey)) {
      this.agentActivity.noteSubagentResolved(sessionKey);
    }
  }

  touchOpenSubagentSlots(sessionKey: string): void {
    if (this.getOrchestratorSession?.(sessionKey)) {
      this.agentActivity.touch(sessionKey);
    }
    const stack = this.openSubagentSlots.get(sessionKey);
    if (!stack) return;
    for (const subject of stack) {
      this.agentActivity.touch(subject);
    }
  }

  recordConcurrencyDenial(
    input: string | ConcurrencyDenialRecord,
    at: number | string = new Date().toISOString()
  ): void {
    const reason =
      typeof input === "string" ? input : (input.reason ?? "unknown");
    this.telemetry.denials += 1;
    this.telemetry.denialsByReason[reason] =
      (this.telemetry.denialsByReason[reason] ?? 0) + 1;
    if (typeof input === "object" && input !== null) {
      const timestamp =
        typeof at === "number"
          ? new Date(at).toISOString()
          : (input.timestamp ?? at);
      this.telemetry.lastDenial = {
        ...input,
        timestamp,
        reason
      };
    } else {
      this.telemetry.lastDenial = {
        timestamp: typeof at === "number" ? new Date(at).toISOString() : at,
        reason
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
    if (!saved || typeof saved !== "object") return;
    if (Number.isInteger(saved.denials) && (saved.denials as number) >= 0) {
      this.telemetry.denials = saved.denials as number;
    }
    if (saved.denialsByReason && typeof saved.denialsByReason === "object") {
      this.telemetry.denialsByReason = { ...saved.denialsByReason };
    }
    if (
      saved.lastDenial === null ||
      (saved.lastDenial && typeof saved.lastDenial === "object")
    ) {
      this.telemetry.lastDenial = saved.lastDenial;
    }
  }

  concurrencyStatus(at = Date.now()): ConcurrencyStatus {
    const processFallbackActiveThreads = this.agentActivity.countLive(
      { kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY },
      at
    );
    return {
      scope: "router-admitted-child-requests",
      configSource: this.configSource,
      configFileExists: existsSync(this.config.file),
      maxConcurrentThreadsPerSession: this.effectivePerSessionLimit(),
      effectivePerSessionLimit: this.effectivePerSessionLimit(),
      activeSubagentThreads: this.agentActivity.countLive(
        { kind: SUBAGENT_SLOT_KIND },
        at
      ),
      activeSessions: this.agentActivity.distinctTags(
        { kind: SUBAGENT_SLOT_KIND },
        at
      ).length,
      processFallbackActiveThreads,
      processFallbackEnforcement: processFallbackActiveThreads > 0,
      denials: this.telemetry.denials,
      denialsByReason: { ...this.telemetry.denialsByReason },
      lastDenial: this.telemetry.lastDenial
    };
  }
}

let defaultConcurrencyManager: ConcurrencyManager | null = null;

export function getDefaultConcurrencyManager(): ConcurrencyManager {
  if (!defaultConcurrencyManager) {
    defaultConcurrencyManager = new ConcurrencyManager({
      agentActivity: createAgentActivityTracker()
    });
  }
  return defaultConcurrencyManager;
}

export function setDefaultConcurrencyManager(
  manager: ConcurrencyManager | null
): void {
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

export function recordConcurrencyDenial(
  input: string | ConcurrencyDenialRecord,
  at?: number | string
): void {
  getDefaultConcurrencyManager().recordConcurrencyDenial(input, at);
}

export function resetConcurrencyTelemetry(): void {
  getDefaultConcurrencyManager().resetConcurrencyTelemetry();
}

export function restoreConcurrencyTelemetry(
  saved?: Partial<ConcurrencyTelemetry> | null
): void {
  getDefaultConcurrencyManager().restoreTelemetry(saved);
}

export function concurrencyStatus(at = Date.now()): ConcurrencyStatus {
  return getDefaultConcurrencyManager().concurrencyStatus(at);
}
