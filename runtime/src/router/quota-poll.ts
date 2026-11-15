/**
 * The quota poll: the Runtime's one record of the quota-axi report and of when
 * each provider's vendor was last asked for it.
 *
 * quota-axi is the single source of every provider's usage. The Runtime only
 * decides *when* to ask it about each provider, and two vendor facts shape
 * that decision.
 *
 * A vendor that refuses a read says when to try again, in the entry's own
 * `state.retryAfter`. The refusal can arrive as `rate_limited` (nothing to
 * show) or as `stale` (quota-axi serving its last good reading while the
 * vendor refuses), and either way the next request before that moment is the
 * request the vendor just asked us not to make.
 *
 * Anthropic's OAuth usage endpoint -- the source of Claude's quota -- refuses
 * after only a few reads and then holds the refusal for close to an hour.
 * Asking it on every sixty-second tick meant it never answered at all, so
 * quota-axi never cached a reading and the Console never had a Claude bar to
 * draw, not even a stale one. Claude is therefore asked at most once per
 * `QUOTA_READ_INTERVAL_MS.claude`.
 *
 * Both waits outlive the process: the record is persisted with the router's
 * state, so a restart neither forgets a retry moment nor spends another read.
 * A provider that is waiting keeps the entry it had -- state, error, windows
 * and retry moment carried forward unchanged -- so the Console keeps showing
 * what was last read and why it is not newer.
 */
import type { QuotaAxiResponse } from "quota-axi";

type QuotaAxiEntry = QuotaAxiResponse["providers"][number];

/**
 * The shortest time between two vendor reads of one provider, for vendors
 * whose quota endpoint cannot be read on every poll tick. A provider absent
 * here is read on every tick.
 */
export const QUOTA_READ_INTERVAL_MS: Readonly<Record<string, number>> =
  Object.freeze({ claude: 5 * 60_000 });

/** What one poll tick should ask quota-axi for. */
export interface QuotaPollPlan {
  /** The providers to read; `null` reads every provider quota-axi knows. */
  readonly providers: readonly string[] | null;
  /** The providers whose entries are carried forward unread. */
  readonly deferred: ReadonlySet<string>;
}

/** The persisted form of the poll's record. */
export interface QuotaPollPersistence {
  readonly report: QuotaAxiResponse | null;
  readonly readAt: Readonly<Record<string, number>>;
}

function retryPending(entry: QuotaAxiEntry, nowMs: number): boolean {
  const retryAt = Date.parse(entry.state?.retryAfter ?? "");
  return Number.isFinite(retryAt) && retryAt > nowMs;
}

function isQuotaAxiReport(value: unknown): value is QuotaAxiResponse {
  if (value === null || typeof value !== "object") return false;
  const report = value as Partial<QuotaAxiResponse>;
  return (
    typeof report.generatedAt === "string" &&
    Array.isArray(report.providers) &&
    report.providers.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.provider === "string" &&
        Array.isArray(entry.windows) &&
        entry.state !== null &&
        typeof entry.state === "object"
    )
  );
}

export class QuotaPoll {
  private current: QuotaAxiResponse | null = null;
  private readonly readAt = new Map<string, number>();
  private readonly intervals: Readonly<Record<string, number>>;

  constructor(
    intervals: Readonly<Record<string, number>> = QUOTA_READ_INTERVAL_MS
  ) {
    this.intervals = intervals;
  }

  /** The report as last read, with waiting providers' entries carried. */
  get report(): QuotaAxiResponse | null {
    return this.current;
  }

  /**
   * Why a provider is not asked on this tick: its vendor named a retry moment
   * that has not arrived, or its last read is younger than its interval.
   */
  private isWaiting(entry: QuotaAxiEntry, nowMs: number): boolean {
    if (retryPending(entry, nowMs)) return true;
    const interval = this.intervals[entry.provider] ?? 0;
    const lastRead = this.readAt.get(entry.provider);
    return lastRead !== undefined && nowMs - lastRead < interval;
  }

  /**
   * The read this tick should make, or `null` when every provider is waiting
   * and there is nothing to ask.
   *
   * The first read asks every provider. After that the set is closed over the
   * providers the report already carries, which is quota-axi's own provider
   * list for a pinned version.
   */
  plan(nowMs: number): QuotaPollPlan | null {
    if (this.current === null) return { providers: null, deferred: new Set() };
    const deferred = new Set<string>();
    const due: string[] = [];
    for (const entry of this.current.providers) {
      if (this.isWaiting(entry, nowMs)) deferred.add(entry.provider);
      else due.push(entry.provider);
    }
    if (due.length === 0) return null;
    return { providers: deferred.size === 0 ? null : due, deferred };
  }

  /**
   * Take the report a plan's read produced: the providers that were read, plus
   * the carried entries of the ones that were deferred.
   */
  accept(next: QuotaAxiResponse, plan: QuotaPollPlan, nowMs: number): void {
    for (const entry of next.providers) this.readAt.set(entry.provider, nowMs);
    const previous = this.current;
    if (previous === null || plan.deferred.size === 0) {
      this.current = next;
      return;
    }
    const merged = new Map<string, QuotaAxiEntry>();
    for (const entry of next.providers) merged.set(entry.provider, entry);
    for (const entry of previous.providers) {
      if (!plan.deferred.has(entry.provider)) continue;
      if (merged.has(entry.provider)) continue;
      merged.set(entry.provider, entry);
    }
    this.current = { ...next, providers: [...merged.values()] };
  }

  persistenceSnapshot(): QuotaPollPersistence {
    return { report: this.current, readAt: Object.fromEntries(this.readAt) };
  }

  /**
   * Restore a persisted record. A malformed record is discarded whole: the
   * poll then starts with a full read, as a first start does.
   */
  restore(value: unknown): boolean {
    this.current = null;
    this.readAt.clear();
    if (value === null || typeof value !== "object") return false;
    const { report, readAt } = value as Partial<QuotaPollPersistence>;
    if (!isQuotaAxiReport(report)) return false;
    this.current = report;
    if (readAt !== null && typeof readAt === "object") {
      for (const [provider, at] of Object.entries(readAt)) {
        if (typeof at === "number" && Number.isFinite(at))
          this.readAt.set(provider, at);
      }
    }
    return true;
  }
}

/** The router process's quota poll. */
export const QUOTA_POLL = new QuotaPoll();
