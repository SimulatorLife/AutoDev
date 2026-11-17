import type { ProviderRole } from "@simulatorlife/autodev-core";
import {
  isHardLimitClass,
  normalizeResetsAt
} from "@simulatorlife/autodev-runtime/shared/provider-limits";

export type CooldownKind = "config" | "probe" | "hard" | "transient";

export interface CooldownEntry {
  until: number;
  kind: CooldownKind;
  failureClass: string | null;
  resetsAt: string | null;
  since: number;
  /** Set when the cooldown covers one model rather than the whole provider. */
  model?: string;
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
}

export interface CooldownConfig {
  providerCooldownMs: number;
  providerCooldownMaxMs: number;
  /** The floor of the hard ladder a limit with no stated reset climbs. */
  hardCooldownMs: number;
  /**
   * The ceiling of that same ladder. It bounds only a limit that carried no
   * reset of its own: a provider that stated a reset is held to exactly that
   * reset, which no router-chosen ceiling may shorten.
   */
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
// The hard ladder: the floor it starts at and the ceiling it stops at. It is
// the policy for a hard limit that named no reset, because a provider that
// named one has already told the router when it may be asked again.
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
  private readonly failureStreaks = new Map<string, number>();
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

  /** Resolve the provider-wide or exact-model cooldown. */
  get(
    provider: string,
    now = Date.now(),
    model: string | null = null
  ): CooldownEntry | null {
    const providerEntry = liveEntry(this.cooldowns, provider, now);
    if (providerEntry) return providerEntry;
    if (model === null) return null;

    return liveEntry(this.modelCooldowns, modelKey(provider, model), now);
  }

  getModelCooldowns(
    provider: string,
    now = Date.now()
  ): Record<string, CooldownEntry> {
    const prefix = modelKey(provider, "");
    const result: Record<string, CooldownEntry> = {};
    for (const key of Array.from(this.modelCooldowns.keys())) {
      if (!key.startsWith(prefix)) continue;
      const entry = liveEntry(this.modelCooldowns, key, now);
      if (!entry) continue;
      const model = entry.model ?? key.slice(prefix.length);
      result[model] = entry;
    }
    return result;
  }

  clearModel(provider: string, model: string): void {
    this.modelCooldowns.delete(modelKey(provider, model));
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
    this.failureStreaks.delete(provider);
    this.probeStreaks.delete(provider);
  }

  clearAll(): void {
    this.cooldowns.clear();
    this.modelCooldowns.clear();
    this.failureStreaks.clear();
    this.probeStreaks.clear();
  }

  /**
   * Clear what a passing live probe disproves: the probe-failure streak and a
   * provider cooldown that a failed probe set. A cooldown the provider declared
   * (a quota, a rate limit) or that request failures set is evidence a probe
   * cannot answer, so it stays until it lapses or a request succeeds.
   */
  clearProbeFailures(provider: string): void {
    this.probeStreaks.delete(provider);
    if (this.cooldowns.get(provider)?.kind === "probe")
      this.cooldowns.delete(provider);
  }

  /** Clear provider health and the model that just succeeded. */
  clearAfterSuccess(provider: string, model: string): void {
    this.cooldowns.delete(provider);
    this.modelCooldowns.delete(modelKey(provider, model));
    this.failureStreaks.delete(provider);
    this.probeStreaks.delete(provider);
  }

  cooldownProvider(
    provider: string,
    {
      now = Date.now(),
      failureClass = null,
      resetsAt = null,
      structured = false,
      model = null,
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
    const record = (
      kind: CooldownKind,
      durationMs: number,
      streak = 0,
      until = now + durationMs,
      resetAt: string | null = resetsAt
    ): CooldownResult => {
      const entry: CooldownEntry = {
        until,
        kind,
        failureClass,
        // The provider's stated reset, kept even when the cooldown itself is
        // transient. It is a fact the provider reported, not a scheduling
        // decision: `until` is when the router will actually retry, and the two
        // legitimately differ when an inferred limit names a window longer than
        // the ladder lets us sleep through. Discarding it here is what made a
        // quota saying "resets in 24m43s" surface as a bare "retry in 480s" --
        // a number derived from the failure streak that had no relationship to
        // the window the provider had just named.
        resetsAt: resetAt,
        since: now
      };
      const existing = this.cooldowns.get(provider);
      const kept = existing && existing.until > until ? existing : entry;
      this.cooldowns.set(provider, kept);
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
      // A structured limit may carry the provider's own reset deadline. It is
      // normalized the way the bridge boundary normalizes it, so the stored
      // value is always an ISO-8601 UTC instant the router can compare with
      // its clock.
      const statedReset = normalizeResetsAt(resetsAt);
      const declared = statedReset ? Date.parse(statedReset) : Number.NaN;
      if (Number.isNaN(declared)) {
        // The provider named no window, so the only policy left is the bounded
        // escalating ladder capped by `hardCooldownMaxMs`. That ceiling is the
        // last consumer of the setting: a stated reset is never clamped to it.
        const streak = this.failureStreak(provider) + 1;
        this.failureStreaks.set(provider, streak);
        const durationMs = Math.min(
          this.config.hardCooldownMaxMs,
          this.config.hardCooldownMs * 2 ** (streak - 1)
        );
        return record("hard", durationMs, streak, now + durationMs);
      }
      if (declared <= now) {
        // The window the provider named has already passed, so there is
        // nothing to wait for: the route gets the short cooldown and is
        // retried soon.
        const until = now + this.config.providerCooldownMs;
        return record("hard", until - now, 0, until, statedReset);
      }
      // A stated reset is the provider's own deadline, and the router holds it
      // whole: the route stays ineligible until that instant, and the entry
      // lapses when it arrives, which is the revalidation the policy asks for.
      // Shortening it to a router-chosen ceiling would put a provider that
      // said "out of usage until Tuesday" back in rotation on the router's
      // clock rather than the provider's.
      //
      // No upper bound is imposed on the value the provider reported: the
      // provider's deadline is the policy here, and a router-side ceiling on
      // it is exactly what that policy exists to forbid. The safeguards live
      // elsewhere -- only a *reported* limit earns a hard cooldown at all, the
      // entry is scoped to the one provider route that failed, and it lapses by
      // itself when the reset arrives.
      return record("hard", declared - now, 0, declared, statedReset);
    }
    const streak = this.failureStreak(provider) + 1;
    this.failureStreaks.set(provider, streak);
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
    if (hardCooldownBlocksAttempt(entry, now)) return false;
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
    return Array.from(this.cooldowns.entries(), ([provider, entry]) => ({
      provider,
      ...entry
    })).filter((entry) => entry.kind === "hard");
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
        // The persisted deadline is restored as it was: a hard cooldown that
        // was declared until a reset three days out still ends three days out
        // after a restart. Re-clamping it here would reset the clock on every
        // restart, which is exactly what the durability policy forbids.
        until,
        kind: "hard",
        failureClass:
          typeof entry.failureClass === "string" ? entry.failureClass : null,
        resetsAt: normalizeResetsAt(entry.resetsAt),
        since: typeof entry.since === "number" ? entry.since : now
      };
      this.cooldowns.set(entry.provider, restored);
    }
  }
}

/**
 * Whether a cooldown makes the route ineligible for any attempt.
 *
 * A provider that declared it is out of usage until a reset time still in the
 * future cannot serve before then, so no path may attempt it: the fallback
 * chain skips such a route (see `allowsLastResort`), and a direct concrete
 * request, which has no alternative candidate to fall back to, has to refuse
 * it locally instead of asking the provider again. The rule lives here so the
 * two paths cannot drift.
 *
 * A `hard` cooldown with no known reset stays attemptable: the provider named
 * no window, so a bounded probe is the only way to learn whether it recovered.
 */
export function hardCooldownBlocksAttempt(
  entry: CooldownEntry | null,
  now = Date.now()
): entry is CooldownEntry {
  if (!entry || entry.kind !== "hard") return false;
  if (!entry.resetsAt) return false;
  const resetsAt = Date.parse(entry.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt > now;
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
