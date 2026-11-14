import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { parse as parseToml, TomlError } from "smol-toml";

import { createAgentActivityTracker } from "../../agents/agent-activity.ts";

export type AgentActivityTracker = ReturnType<
  typeof createAgentActivityTracker
>;

export const PROCESS_FALLBACK_SESSION_KEY = "process-scope";
export const SUBAGENT_SLOT_KIND = "subagent_slot";

export interface ConcurrencyConfig {
  file: string;
  /**
   * The limit the config file declares.
   *
   * Three states, and the third is the one that used to be missing. `null` is
   * a file that was read and declares no limit -- the default deployment. A
   * number is a file that was read and declares that limit. `undefined` is a
   * file that was there and could not be read: nobody knows what it declares.
   *
   * `null` and `undefined` are different claims, and the deployment acts on
   * the difference. A file that cannot be read leaves the router enforcing no
   * limit at all, which is a cap the operator set silently disappearing -- so
   * the state that says "nobody read it" has to survive all the way to the
   * Console, which is where the operator would see it.
   */
  maxConcurrentThreadsPerSession: number | null | undefined;
}

export interface ConcurrencyDenialRecord {
  timestamp?: string;
  reason: string;
  sessionKey?: string;
  [key: string]: unknown;
}

/**
 * Where the limit in force came from.
 *
 * The operator has to be able to tell three things apart: a limit a stored
 * override put in place, a limit the config file declares, and no limit
 * declared by anything the Runtime could read. The published word says which,
 * so the Console does not have to infer it.
 */
export type ConcurrencyLimitSource =
  "stored_override" | "config_file" | "default";

/**
 * Which config file the router read.
 *
 * A different fact from the limit's source: this one answers "which file did
 * the router consult", and the limit's source answers "what did that file say".
 * One word cannot carry both, and when it tried, the consumer read the file's
 * location as the limit's source and was wrong about every limit the operator
 * had configured.
 */
export type ConcurrencyConfigFileSource = "default_codex_home" | "env_override";

export interface ConcurrencyTelemetry {
  denials: number;
  denialsByReason: Record<string, number>;
  lastDenial: ConcurrencyDenialRecord | null;
}

export interface ConcurrencyStatus {
  scope: string;
  /**
   * Where the limit in force came from.
   *
   * `stored_override` is a stored override, `config_file` is the limit the
   * config file declares, and `default` is nothing that could be read
   * declaring a limit. The operator reads this word to know whether the cap in
   * force is theirs, so it names the limit's source rather than the file's
   * location.
   */
  configSource: ConcurrencyLimitSource;
  /** Which config file the router read. A different fact from the limit's source. */
  configFileSource: ConcurrencyConfigFileSource;
  configFileExists: boolean;
  /**
   * The limit the config file declares.
   *
   * `undefined` means the file was there and could not be read, so the limit
   * in force (`effectivePerSessionLimit`) is not the one that was configured.
   * It travels as an absent field rather than as `null`, because `null` is a
   * file that declares no limit.
   */
  maxConcurrentThreadsPerSession?: number | null;
  effectivePerSessionLimit: number | null;
  activeSubagentThreads: number;
  activeSessions: number;
  processFallbackActiveThreads: number;
  processFallbackEnforcement: boolean;
  denials: number;
  denialsByReason: Record<string, number>;
  lastDenial: ConcurrencyDenialRecord | null;
  revision: number;
}

export interface ConcurrencyManagerOptions {
  agentActivity: AgentActivityTracker;
  configFile?: string;
  configFileSource?: ConcurrencyConfigFileSource;
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

const CONCURRENCY_KEY = "max_concurrent_threads_per_session";

class InvalidConcurrencySettingError extends Error {}

/**
 * The limit a parsed TOML document declares, or null when it declares none.
 *
 * A document that parsed but declares something that is not a usable limit --
 * `agents` that is not a table, or a value that is not a non-negative safe
 * integer -- is not a confirmed absent cap, so it throws and is reported as unread.
 * Integers smol-toml cannot represent losslessly already fail the parse.
 * `max_threads` is a legacy alias and is not consulted.
 */
function declaredLimit(document: Record<string, unknown>): number | null {
  const agents = document.agents;
  if (agents === undefined) return null;
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
    throw new InvalidConcurrencySettingError("agents must be a table");
  }
  const value = (agents as Record<string, unknown>)[CONCURRENCY_KEY];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidConcurrencySettingError(
      `${CONCURRENCY_KEY} must be a non-negative safe integer`
    );
  }
  return value;
}

const FS_ERROR_CODE = /^[A-Z0-9_]+$/;

/**
 * A warning-safe reason for an unread config, safe by construction: only our
 * own setting errors, a generic TOML category, or a filesystem error code are
 * logged. Parser errors quote the offending document line and the config can
 * hold credentials, so no other thrown message is ever echoed.
 */
function unreadReason(error: unknown): string {
  if (error instanceof InvalidConcurrencySettingError) return error.message;
  if (error instanceof TomlError) return "invalid TOML syntax";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && FS_ERROR_CODE.test(code)) {
    return "filesystem error " + code;
  }
  return "unexpected error";
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
    result.maxConcurrentThreadsPerSession = declaredLimit(
      parseToml(readFileSync(file, "utf8"))
    );
  } catch (error) {
    // The file is there and could not be read as a valid declaration -- an I/O
    // failure, a TOML syntax error, or a setting that is not a usable limit --
    // so nobody knows what it declares. `undefined` is that state; `null` is a
    // file that declares no limit, and a cap the operator set is not the same
    // thing as a cap that was never read.
    result.maxConcurrentThreadsPerSession = undefined;
    writeErrorLine(
      `Warning: could not read Codex concurrency config from ${file}: ${unreadReason(error)}`
    );
  }
  return result;
}

export class ConcurrencyManager {
  private readonly agentActivity: AgentActivityTracker;
  private readonly config: ConcurrencyConfig;
  private readonly configFileSource: ConcurrencyConfigFileSource;
  private readonly getOrchestratorSession?:
    | ((sessionKey: string) => {
        provider?: string | null;
        model?: string | null;
        workspace?: string | null;
      } | null)
    | undefined;
  private readonly openSubagentSlots = new Map<string, string[]>();
  private subagentSlotSequence = 0;
  private storedLimit: number | null | undefined = undefined;
  public revision = 1;
  public readonly telemetry: ConcurrencyTelemetry = {
    denials: 0,
    denialsByReason: {},
    lastDenial: null
  };

  constructor(options: ConcurrencyManagerOptions) {
    this.agentActivity = options.agentActivity;
    this.config =
      options.initialConfig ?? parseConcurrencyConfig(options.configFile);
    this.configFileSource =
      options.configFileSource ??
      (process.env.CODEX_ROUTER_CODEX_CONFIG_FILE
        ? "env_override"
        : "default_codex_home");
    this.getOrchestratorSession = options.getOrchestratorSession;
  }

  get configFile(): string {
    return this.config.file;
  }

  effectivePerSessionLimit(): number | null {
    if (this.storedLimit !== undefined) {
      return this.storedLimit;
    }
    // A config file nobody read declares no enforceable limit, so the router
    // admits without a cap -- but the status says so separately, because the
    // cap that was configured is not the cap that is in force.
    return this.config.maxConcurrentThreadsPerSession ?? null;
  }

  setMaxConcurrentThreadsPerSession(
    limit: number | null,
    expectedRevision?: number
  ):
    | { ok: true; revision: number }
    | { ok: false; conflict: true; currentRevision: number } {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, conflict: true, currentRevision: this.revision };
    }
    this.storedLimit = limit;
    this.revision += 1;
    return { ok: true, revision: this.revision };
  }

  clearStoredLimit(
    expectedRevision?: number
  ):
    | { ok: true; revision: number }
    | { ok: false; conflict: true; currentRevision: number } {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, conflict: true, currentRevision: this.revision };
    }
    this.storedLimit = undefined;
    this.revision += 1;
    return { ok: true, revision: this.revision };
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

  persistenceSnapshot(): Record<string, unknown> {
    return {
      ...this.telemetry,
      storedLimit: this.storedLimit,
      revision: this.revision
    };
  }

  restorePersistence(saved?: Record<string, unknown> | null): void {
    if (!saved || typeof saved !== "object") return;
    this.restoreTelemetry(saved);
    if ("storedLimit" in saved) {
      const val = saved.storedLimit;
      if (
        val === null ||
        (typeof val === "number" && Number.isInteger(val) && val >= 0)
      ) {
        this.storedLimit = val as number | null;
      } else if (val === undefined) {
        this.storedLimit = undefined;
      }
    }
    if (
      typeof saved.revision === "number" &&
      Number.isInteger(saved.revision)
    ) {
      this.revision = saved.revision;
    }
  }

  concurrencyStatus(at = Date.now()): ConcurrencyStatus {
    const processFallbackActiveThreads = this.agentActivity.countLive(
      { kind: SUBAGENT_SLOT_KIND, tag: PROCESS_FALLBACK_SESSION_KEY },
      at
    );
    const isStored = this.storedLimit !== undefined;
    const configuredLimit = this.config.maxConcurrentThreadsPerSession;
    // Where the limit in force came from. A stored override wins outright; a
    // config file that declares a number is the source; and anything else --
    // a file that declares no limit, or a file nobody could read -- leaves no
    // declared limit in force, so the router's default is what is running.
    const configSource: ConcurrencyLimitSource = isStored
      ? "stored_override"
      : typeof configuredLimit === "number"
        ? "config_file"
        : "default";
    return {
      scope: "router-admitted-child-requests",
      configSource,
      configFileSource: this.configFileSource,
      configFileExists: existsSync(this.config.file),
      // The configured limit travels only when it was read. A file that could
      // not be read leaves the field absent rather than `null`, because `null`
      // is a file that declares no limit -- and the difference is the
      // difference between "the operator configured no cap" and "nobody read
      // the cap the operator configured".
      ...(configuredLimit === undefined
        ? {}
        : { maxConcurrentThreadsPerSession: configuredLimit }),
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
      lastDenial: this.telemetry.lastDenial,
      revision: this.revision
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
