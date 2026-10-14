import type { ProviderRole } from "@simulatorlife/autodev-core";
import {
  isHardLimitClass,
  normalizeResetsAt
} from "@simulatorlife/autodev-runtime/shared/provider-limits";
import { providerQuotaPool } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

export type CooldownKind = "config" | "probe" | "hard" | "transient";

export interface CooldownEntry {
  until: number;
  kind: CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  since: number;
  /** Set when the cooldown covers one model rather than the whole provider. */
  model?: string;
  /** Set when the cooldown covers a provider's shared model-family quota. */
  pool?: string;
  /** The provider's own explanation, for failures only the user can fix. */
  detail?: string | null;
}

export interface CooldownResult {
  provider: string;
  kind: CooldownKind;
  streak: number;
  durationMs: number;
  cooldownUntil: number;
  resetsAt: string | null;
}

export interface CooldownOptions {
  now?: number;
  failureClass?: string | null;
  resetsAt?: string | null;
  structured?: boolean;
  /** The model that failed; an `invalid_model` failure cools down only it. */
  model?: string | null;
  /** Scope `quota_exhausted` to the model's configured family pool. */
  scope?: "provider" | "pool";
  detail?: string | null;
}

export interface CooldownSummary {
  provider: string;
  model: string | null;
  state: "disabled" | "available" | CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  retryAfterMs: number;
  detail: string | null;
}

export interface PersistedCooldownEntry {
  provider: string;
  until: number;
  kind: CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  since: number;
  pool?: string;
}

export interface CooldownConfig {
  providerCooldownMs: number;
  providerCooldownMaxMs: number;
  hardCooldownMs: number;
  hardCooldownMaxMs: number;
  probeCooldownMs: number;
  probeCooldownMaxMs: number;
}

export interface CooldownRuntime {
  isProviderEnabled?: (provider: string, role: ProviderRole) => boolean;
  isKnownProvider?: (provider: string) => boolean;
  lastFailureClass?: (provider: string) => string | null;
}

export const PROBE_FAILURE_CLASS = "probe_unavailable";

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const providerCooldownMs = positiveDuration(
  process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MS,
  30_000
);
const providerCooldownMaxMs = Math.max(
  providerCooldownMs,
  positiveDuration(process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MAX_MS, 600_000)
);
const hardCooldownMs = positiveDuration(
  process.env.CODEX_ROUTER_HARD_COOLDOWN_MS,
  900_000
);
const hardCooldownMaxMs = Math.max(
  hardCooldownMs,
  positiveDuration(process.env.CODEX_ROUTER_HARD_COOLDOWN_MAX_MS, 21_600_000)
);
const probeCooldownMs = positiveDuration(
  process.env.CODEX_ROUTER_PROBE_COOLDOWN_MS,
  5000
);
const probeCooldownMaxMs = Math.max(
  probeCooldownMs,
  positiveDuration(process.env.CODEX_ROUTER_PROBE_COOLDOWN_MAX_MS, 30_000)
);

export const COOLDOWN_CONFIG: Readonly<CooldownConfig> = Object.freeze({
  providerCooldownMs,
  providerCooldownMaxMs,
  hardCooldownMs,
  hardCooldownMaxMs,
  probeCooldownMs,
  probeCooldownMaxMs
});

export class ProviderCooldowns {
  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly modelCooldowns = new Map<string, CooldownEntry>();
  private readonly poolCooldowns = new Map<string, CooldownEntry>();
  private readonly failureStreaks = new Map<string, number>();
  private readonly poolFailureStreaks = new Map<string, number>();
  private readonly probeStreaks = new Map<string, number>();
  private runtime: CooldownRuntime;

  readonly config: Readonly<CooldownConfig>;

  constructor(
    config: Readonly<CooldownConfig> = COOLDOWN_CONFIG,
    runtime: CooldownRuntime = {}
  ) {
    this.config = config;
    this.runtime = runtime;
  }

  setRuntime(runtime: CooldownRuntime): void {
    this.runtime = runtime;
  }

  /** Resolve the provider-wide, exact-model, or configured quota-pool cooldown. */
  get(
    provider: string,
    now = Date.now(),
    model: string | null = null
  ): CooldownEntry | null {
    const providerEntry = liveEntry(this.cooldowns, provider, now);
    if (providerEntry || model === null) return providerEntry;

    const modelEntry = liveEntry(
      this.modelCooldowns,
      modelKey(provider, model),
      now
    );
    if (modelEntry) return modelEntry;

    const pool = providerQuotaPool(provider, model);
    return pool === null
      ? null
      : liveEntry(this.poolCooldowns, modelKey(provider, pool), now);
  }

  isCooling(
    provider: string,
    now = Date.now(),
    model: string | null = null
  ): boolean {
    return this.get(provider, now, model) !== null;
  }

  failureStreak(provider: string): number {
    return this.failureStreaks.get(provider) ?? 0;
  }

  probeFailureStreak(provider: string): number {
    return this.probeStreaks.get(provider) ?? 0;
  }

  clear(provider: string): void {
    this.cooldowns.delete(provider);
    for (const key of this.modelCooldowns.keys())
      if (key.startsWith(modelKey(provider, "")))
        this.modelCooldowns.delete(key);
    for (const key of this.poolCooldowns.keys())
      if (key.startsWith(modelKey(provider, "")))
        this.poolCooldowns.delete(key);
    for (const key of this.poolFailureStreaks.keys())
      if (key.startsWith(modelKey(provider, "")))
        this.poolFailureStreaks.delete(key);
    this.failureStreaks.delete(provider);
    this.probeStreaks.delete(provider);
  }

  clearAll(): void {
    this.cooldowns.clear();
    this.modelCooldowns.clear();
    this.poolCooldowns.clear();
    this.failureStreaks.clear();
    this.poolFailureStreaks.clear();
    this.probeStreaks.clear();
  }

  /** Clear provider health and only the quota pool that just succeeded. */
  clearAfterSuccess(provider: string, model: string): void {
    this.cooldowns.delete(provider);
    this.modelCooldowns.delete(modelKey(provider, model));
    this.failureStreaks.delete(provider);
    this.probeStreaks.delete(provider);

    const pool = providerQuotaPool(provider, model);
    if (pool === null) return;
    const key = modelKey(provider, pool);
    this.poolCooldowns.delete(key);
    this.poolFailureStreaks.delete(key);
  }

  cooldownProvider(
    provider: string,
    {
      now = Date.now(),
      failureClass = null,
      resetsAt = null,
      structured = false,
      model = null,
      scope = "provider",
      detail = null
    }: CooldownOptions = {}
  ): CooldownResult {
    if (failureClass === "invalid_model" && model !== null) {
      const until = now + this.config.providerCooldownMs;
      this.modelCooldowns.set(modelKey(provider, model), {
        until,
        kind: "config",
        failureClass,
        resetsAt: null,
        since: now,
        model,
        detail
      });
      return {
        provider,
        kind: "config",
        streak: 0,
        durationMs: until - now,
        cooldownUntil: until,
        resetsAt: null
      };
    }
    const scopedPool =
      scope === "pool" ? providerQuotaPool(provider, model) : null;
    const poolScoped =
      scopedPool !== null && failureClass === "quota_exhausted";
    const record = (
      kind: CooldownKind,
      durationMs: number,
      streak = 0,
      until = now + durationMs
    ): CooldownResult => {
      const entry: CooldownEntry = {
        until,
        kind,
        failureClass,
        resetsAt: kind === "hard" ? resetsAt : null,
        since: now
      };
      const target = poolScoped ? this.poolCooldowns : this.cooldowns;
      const key = poolScoped ? modelKey(provider, scopedPool) : provider;
      const existing = target.get(key);
      const kept = existing && existing.until > until ? existing : entry;
      target.set(key, poolScoped ? { ...kept, pool: scopedPool } : kept);
      return {
        provider,
        kind,
        streak,
        durationMs: until - now,
        cooldownUntil: kept.until,
        resetsAt: kept.resetsAt
      };
    };

    if (failureClass === "authentication" || failureClass === "invalid_model") {
      return record("config", this.config.providerCooldownMs);
    }
    if (failureClass === PROBE_FAILURE_CLASS) {
      const streak = this.probeFailureStreak(provider) + 1;
      this.probeStreaks.set(provider, streak);
      return record(
        "probe",
        Math.min(
          this.config.probeCooldownMaxMs,
          this.config.probeCooldownMs * 2 ** (streak - 1)
        ),
        streak
      );
    }
    if (structured && isHardLimitClass(failureClass ?? "")) {
      const declared = resetsAt ? Date.parse(resetsAt) : Number.NaN;
      const until = Number.isNaN(declared)
        ? now + this.config.hardCooldownMs
        : declared <= now
          ? now + this.config.providerCooldownMs
          : Math.min(declared, now + this.config.hardCooldownMaxMs);
      return record("hard", until - now, 0, until);
    }
    const streak = poolScoped
      ? (this.poolFailureStreaks.get(modelKey(provider, scopedPool)) ?? 0) + 1
      : this.failureStreak(provider) + 1;
    if (poolScoped)
      this.poolFailureStreaks.set(modelKey(provider, scopedPool), streak);
    else this.failureStreaks.set(provider, streak);
    return record(
      "transient",
      Math.min(
        this.config.providerCooldownMaxMs,
        this.config.providerCooldownMs * 2 ** (streak - 1)
      ),
      streak
    );
  }

  nextRetryMs(
    candidates: readonly { provider: string; model: string }[],
    now = Date.now()
  ): number {
    let earliest: number | null = null;
    for (const { provider, model } of candidates) {
      const entry = this.get(provider, now, model);
      if (
        entry &&
        entry.kind !== "config" &&
        entry.until > now &&
        (earliest === null || entry.until < earliest)
      )
        earliest = entry.until;
    }
    return earliest === null ? 0 : earliest - now;
  }

  allowsLastResort(entry: CooldownEntry | null, now = Date.now()): boolean {
    if (!entry) return true;
    if (entry.kind === "config") return false;
    if (
      entry.kind === "hard" &&
      entry.resetsAt &&
      Date.parse(entry.resetsAt) > now
    )
      return false;
    return true;
  }

  summary(
    candidates: readonly { provider: string; model: string }[],
    now = Date.now(),
    role: ProviderRole = "subagent"
  ): CooldownSummary[] {
    const seen = new Set<string>();
    return candidates
      .filter(({ provider }) => !seen.has(provider) && seen.add(provider))
      .map(({ provider, model }) => {
        if (
          this.runtime.isProviderEnabled &&
          !this.runtime.isProviderEnabled(provider, role)
        ) {
          return {
            provider,
            model,
            state: "disabled",
            failureClass: "provider_disabled",
            resetsAt: null,
            retryAfterMs: 0,
            detail: null
          };
        }
        const entry = this.get(provider, now, model);
        return {
          provider,
          model,
          state: entry ? entry.kind : "available",
          failureClass: entry
            ? entry.failureClass
            : (this.runtime.lastFailureClass?.(provider) ?? null),
          resetsAt: entry ? entry.resetsAt : null,
          retryAfterMs: entry ? entry.until - now : 0,
          detail: entry?.detail ?? null
        };
      });
  }

  persistedHardEntries(): PersistedCooldownEntry[] {
    const providerEntries = Array.from(
      this.cooldowns.entries(),
      ([provider, entry]) => ({ provider, ...entry })
    );
    const poolEntries = Array.from(
      this.poolCooldowns.entries(),
      ([key, entry]) => ({
        provider: key.slice(0, key.indexOf("\u0000")),
        ...entry
      })
    );
    return [...providerEntries, ...poolEntries].filter(
      (entry) => entry.kind === "hard"
    );
  }

  restoreHardEntries(entries: readonly unknown[], now = Date.now()): void {
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        entry.kind !== "hard" ||
        typeof entry.provider !== "string"
      )
        continue;
      if (
        this.runtime.isKnownProvider &&
        !this.runtime.isKnownProvider(entry.provider)
      )
        continue;
      const until = Number(entry.until);
      if (!Number.isFinite(until) || until <= now) continue;
      const restored: CooldownEntry = {
        until: Math.min(until, now + this.config.hardCooldownMaxMs),
        kind: "hard",
        failureClass:
          typeof entry.failureClass === "string" ? entry.failureClass : null,
        resetsAt: normalizeResetsAt(entry.resetsAt),
        since: typeof entry.since === "number" ? entry.since : now
      };
      if (typeof entry.pool === "string") {
        restored.pool = entry.pool;
        this.poolCooldowns.set(modelKey(entry.provider, entry.pool), restored);
      } else this.cooldowns.set(entry.provider, restored);
    }
  }
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function liveEntry(
  entries: Map<string, CooldownEntry>,
  key: string,
  now: number
): CooldownEntry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.until > now) return entry;
  entries.delete(key);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const COOLDOWNS = new ProviderCooldowns();
