import { isHardLimitClass, normalizeResetsAt } from '../shared/provider-limits.ts';

export type CooldownKind = 'config' | 'probe' | 'hard' | 'transient';

export interface CooldownEntry {
  until: number;
  kind: CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  since: number;
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
}

export interface CooldownSummary {
  provider: string;
  state: 'disabled' | 'available' | CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  retryAfterMs: number;
}

export interface PersistedCooldownEntry {
  provider: string;
  until: number;
  kind: CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  since: number;
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
  isProviderEnabled?: (provider: string) => boolean;
  isKnownProvider?: (provider: string) => boolean;
  lastFailureClass?: (provider: string) => string | null;
}

export const PROBE_FAILURE_CLASS = 'probe_unavailable';

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const providerCooldownMs = positiveDuration(process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MS, 30_000);
const providerCooldownMaxMs = Math.max(providerCooldownMs, positiveDuration(process.env.CODEX_ROUTER_PROVIDER_COOLDOWN_MAX_MS, 600_000));
const hardCooldownMs = positiveDuration(process.env.CODEX_ROUTER_HARD_COOLDOWN_MS, 900_000);
const hardCooldownMaxMs = Math.max(hardCooldownMs, positiveDuration(process.env.CODEX_ROUTER_HARD_COOLDOWN_MAX_MS, 21_600_000));
const probeCooldownMs = positiveDuration(process.env.CODEX_ROUTER_PROBE_COOLDOWN_MS, 5_000);
const probeCooldownMaxMs = Math.max(probeCooldownMs, positiveDuration(process.env.CODEX_ROUTER_PROBE_COOLDOWN_MAX_MS, 30_000));

export const COOLDOWN_CONFIG: Readonly<CooldownConfig> = Object.freeze({
  providerCooldownMs,
  providerCooldownMaxMs,
  hardCooldownMs,
  hardCooldownMaxMs,
  probeCooldownMs,
  probeCooldownMaxMs,
});

export class ProviderCooldowns {
  private readonly cooldowns = new Map<string, CooldownEntry>();
  private readonly failureStreaks = new Map<string, number>();
  private readonly probeStreaks = new Map<string, number>();
  private runtime: CooldownRuntime;

  readonly config: Readonly<CooldownConfig>;

  constructor(config: Readonly<CooldownConfig> = COOLDOWN_CONFIG, runtime: CooldownRuntime = {}) {
    this.config = config;
    this.runtime = runtime;
  }

  setRuntime(runtime: CooldownRuntime): void {
    this.runtime = runtime;
  }

  get(provider: string, now = Date.now()): CooldownEntry | null {
    const entry = this.cooldowns.get(provider);
    if (!entry) return null;
    if (entry.until > now) return entry;
    this.cooldowns.delete(provider);
    return null;
  }

  isCooling(provider: string, now = Date.now()): boolean {
    return this.get(provider, now) !== null;
  }

  failureStreak(provider: string): number {
    return this.failureStreaks.get(provider) ?? 0;
  }

  probeFailureStreak(provider: string): number {
    return this.probeStreaks.get(provider) ?? 0;
  }

  clear(provider: string): void {
    this.cooldowns.delete(provider);
    this.failureStreaks.delete(provider);
    this.probeStreaks.delete(provider);
  }

  clearAll(): void {
    this.cooldowns.clear();
    this.failureStreaks.clear();
    this.probeStreaks.clear();
  }

  cooldownProvider(provider: string, { now = Date.now(), failureClass = null, resetsAt = null, structured = false }: CooldownOptions = {}): CooldownResult {
    const record = (kind: CooldownKind, durationMs: number, streak = 0, until = now + durationMs): CooldownResult => {
      const entry: CooldownEntry = { until, kind, failureClass, resetsAt: kind === 'hard' ? resetsAt : null, since: now };
      const existing = this.cooldowns.get(provider);
      const kept = existing && existing.until > until ? existing : entry;
      this.cooldowns.set(provider, kept);
      return { provider, kind, streak, durationMs: until - now, cooldownUntil: kept.until, resetsAt: kept.resetsAt };
    };

    if (failureClass === 'authentication' || failureClass === 'invalid_model') {
      return record('config', this.config.providerCooldownMs);
    }
    if (failureClass === PROBE_FAILURE_CLASS) {
      const streak = this.probeFailureStreak(provider) + 1;
      this.probeStreaks.set(provider, streak);
      return record('probe', Math.min(this.config.probeCooldownMaxMs, this.config.probeCooldownMs * (2 ** (streak - 1))), streak);
    }
    if (structured && isHardLimitClass(failureClass ?? '')) {
      const declared = resetsAt ? Date.parse(resetsAt) : Number.NaN;
      const until = Number.isNaN(declared)
        ? now + this.config.hardCooldownMs
        : declared <= now
          ? now + this.config.providerCooldownMs
          : Math.min(declared, now + this.config.hardCooldownMaxMs);
      return record('hard', until - now, 0, until);
    }
    const streak = this.failureStreak(provider) + 1;
    this.failureStreaks.set(provider, streak);
    return record('transient', Math.min(this.config.providerCooldownMaxMs, this.config.providerCooldownMs * (2 ** (streak - 1))), streak);
  }

  nextRetryMs(providers: readonly string[], now = Date.now()): number {
    let earliest: number | null = null;
    for (const provider of providers) {
      const entry = this.cooldowns.get(provider);
      if (entry && entry.until > now && (earliest === null || entry.until < earliest)) earliest = entry.until;
    }
    return earliest === null ? 0 : earliest - now;
  }

  allowsLastResort(entry: CooldownEntry | null, now = Date.now()): boolean {
    if (!entry) return true;
    if (entry.kind === 'config') return false;
    if (entry.kind === 'hard' && entry.resetsAt && Date.parse(entry.resetsAt) > now) return false;
    return true;
  }

  summary(providers: readonly string[], now = Date.now()): CooldownSummary[] {
    return [...new Set(providers)].map((provider) => {
      if (this.runtime.isProviderEnabled && !this.runtime.isProviderEnabled(provider)) {
        return { provider, state: 'disabled', failureClass: 'provider_disabled', resetsAt: null, retryAfterMs: 0 };
      }
      const entry = this.cooldowns.get(provider);
      const cooling = entry !== undefined && entry.until > now;
      return {
        provider,
        state: cooling ? entry.kind : 'available',
        failureClass: cooling ? entry.failureClass : this.runtime.lastFailureClass?.(provider) ?? null,
        resetsAt: cooling ? entry.resetsAt : null,
        retryAfterMs: cooling ? entry.until - now : 0,
      };
    });
  }

  persistedHardEntries(): PersistedCooldownEntry[] {
    return [...this.cooldowns.entries()]
      .filter(([, entry]) => entry.kind === 'hard')
      .map(([provider, entry]) => ({ provider, ...entry }));
  }

  restoreHardEntries(entries: readonly unknown[], now = Date.now()): void {
    for (const entry of entries) {
      if (!isRecord(entry) || entry.kind !== 'hard' || typeof entry.provider !== 'string') continue;
      if (this.runtime.isKnownProvider && !this.runtime.isKnownProvider(entry.provider)) continue;
      const until = Number(entry.until);
      if (!Number.isFinite(until) || until <= now) continue;
      this.cooldowns.set(entry.provider, {
        until: Math.min(until, now + this.config.hardCooldownMaxMs),
        kind: 'hard',
        failureClass: typeof entry.failureClass === 'string' ? entry.failureClass : null,
        resetsAt: normalizeResetsAt(entry.resetsAt),
        since: typeof entry.since === 'number' ? entry.since : now,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const COOLDOWNS = new ProviderCooldowns();
