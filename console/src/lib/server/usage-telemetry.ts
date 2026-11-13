/**
 * The Console's Usage telemetry read.
 *
 * This module owns every read the Console makes of the Usage telemetry
 * store, and it is the only place that decides whether a read is worth
 * repeating.
 *
 * Why a read is expensive enough to cache
 * ---------------------------------------
 *
 * One Usage read is not one query. The Usage service answers a selection
 * with the whole dashboard, and it answers it by running roughly eighteen
 * widget queries against its ClickHouse store in parallel. That store is
 * small: two CPUs. The same widget query that takes fifty milliseconds on
 * its own takes twenty to a hundred and fifty seconds inside the fan-out,
 * because the fan-out saturates the CPUs the queries share and each query
 * then waits for the others. The measured cost of one dashboard read was
 * between two minutes and two and a half minutes; the same read against a
 * warm store settles in a second or two.
 *
 * So the read is expensive because of the store it lands on, not because of
 * the data it asks for, and the only two ways to make it affordable are to
 * ask for it less often or to ask for it once instead of many times. This
 * module does both.
 *
 * Why the window is five minutes
 * -------------------------------
 *
 * The read is a historical aggregation, not live runtime state: it answers
 * "how many requests did this workspace make in the last twenty-four hours"
 * or "how many attempts did this provider make in the last seven days". A
 * window that long does not move under the operator's feet. Five minutes is
 * immaterial against a twenty-four hour window -- the numbers it reports
 * change by fractions of a percent in that time -- and it is the interval at
 * which one read is paid per five minutes of Console use rather than one per
 * navigation. A shorter window would spend the read's cost without making
 * the answer any truer.
 *
 * Why the Control API reads stay uncached
 * ----------------------------------------
 *
 * The Control API reads in `src/lib/server/control-api.ts` answer live
 * runtime state -- which providers exist, whether a workspace is served, what
 * a session is doing right now -- and that file already documents that one of
 * its reads is never a cached one. Those reads are also cheap: the Control
 * API answers in one to thirty milliseconds. Only the Usage telemetry
 * aggregate is expensive enough to be worth caching, and only the Usage
 * telemetry aggregate is a historical fact rather than a live one, so only
 * the Usage telemetry aggregate is cached here.
 *
 * What is cached, and what is not
 * -------------------------------
 *
 * A successful read is cached for the window above. A failed read is not
 * cached: a source that was unreachable a moment ago may answer now, and a
 * cached failure would keep the Console reporting an outage that has ended.
 * Concurrent callers still share one read whether it succeeds or fails, so a
 * burst of navigation cannot turn one expensive read into many.
 */

import type { UsageFilterSelection } from "@simulatorlife/autodev-core";

import { type ConsoleUsageResult, loadOpenLITUsage } from "./openlit-usage.ts";

/**
 * How long a successful read is served from the cache.
 *
 * Five minutes against a twenty-four or seven-day window: long enough that
 * one read is paid per five minutes of Console use, short enough that a
 * reopened Console does not show yesterday's numbers for long.
 */
export const USAGE_TELEMETRY_TTL_MS = 300_000;

/** A cached read and the instant it stops being served. */
interface CachedUsageTelemetry {
  readonly result: ConsoleUsageResult;
  readonly expiresAt: number;
}

/** The successful reads, keyed by the canonical form of their selection. */
const USAGE_TELEMETRY_CACHE = new Map<string, CachedUsageTelemetry>();

/**
 * The reads currently running, keyed the same way.
 *
 * This is what makes a burst of navigation cost one read rather than one
 * read per navigation: the callers that arrive while a read is running share
 * it, because the fan-out behind it is the expensive part and running it
 * twice would cost twice as much for the same answer.
 */
const USAGE_TELEMETRY_IN_FLIGHT = new Map<
  string,
  Promise<ConsoleUsageResult>
>();

export interface UsageTelemetryOptions {
  /**
   * How long a successful read is served from the cache.
   *
   * Overridable so a test can watch an entry expire without waiting five
   * minutes for it.
   */
  readonly ttlMs?: number;
  /**
   * The clock the cache reads.
   *
   * Overridable for the same reason as the window: a test needs to move time
   * forward, not wait for it.
   */
  readonly now?: () => number;
  /**
   * The read the cache sits in front of.
   *
   * The production read is the OpenLIT adapter; a test passes its own so it
   * can count the reads that actually happened.
   */
  readonly load?: (
    selection: UsageFilterSelection
  ) => Promise<ConsoleUsageResult>;
}

/**
 * The canonical form of a selection, and the cache key it produces.
 *
 * Two selections that ask the same question have to reach the same key, or
 * the cache would answer one of them from a read of the other. The parts of
 * a selection that carry meaning are its window, its filter values and its
 * custom bounds, so the key is built from exactly those: the filter axes in
 * a fixed order, the values within each axis in a fixed order, and the
 * custom bounds when the selection has them.
 *
 * The order of the values within one axis is not part of the question -- a
 * selection on two providers asks about those two providers whichever order
 * they are written in -- so the key sorts them. Sorting the axes themselves
 * is what keeps two selections that name the same axes in a different order
 * from reading as two different questions.
 */
export function usageTelemetryCacheKey(
  selection: UsageFilterSelection
): string {
  const values: Record<string, readonly string[]> = {};
  for (const axis of Object.keys(selection.values).sort()) {
    const axisValues = selection.values[axis as keyof typeof selection.values];
    if (axisValues === undefined) continue;
    values[axis] = [...axisValues].sort();
  }
  return JSON.stringify({
    range: selection.range,
    values,
    ...(selection.customRange === undefined
      ? {}
      : { customRange: selection.customRange })
  });
}

/**
 * Read the Usage telemetry, from the cache when the cache can answer.
 *
 * The read is the one the whole Console shares. A caller that arrives inside
 * the window gets the cached answer; a caller that arrives while a read is
 * running shares that read; a caller that arrives after either gets a read
 * of its own.
 */
export function readUsageTelemetry(
  selection: UsageFilterSelection,
  options: UsageTelemetryOptions = {}
): Promise<ConsoleUsageResult> {
  const key = usageTelemetryCacheKey(selection);
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? USAGE_TELEMETRY_TTL_MS;
  const cached = USAGE_TELEMETRY_CACHE.get(key);
  if (cached !== undefined) {
    if (cached.expiresAt > now()) return Promise.resolve(cached.result);
    // The entry has expired. It is dropped rather than kept: a stale answer
    // is not an answer, and leaving it in the map would let a later caller
    // read it as one.
    USAGE_TELEMETRY_CACHE.delete(key);
  }
  const inFlight = USAGE_TELEMETRY_IN_FLIGHT.get(key);
  if (inFlight !== undefined) return inFlight;

  const load = options.load ?? loadOpenLITUsage;
  const read = load(selection).then(
    (result) => {
      USAGE_TELEMETRY_IN_FLIGHT.delete(key);
      // Only a read that produced telemetry is cached. A source that was
      // unreachable, refused the credential, or answered with something the
      // Console cannot use is a fact about this moment, not a fact about the
      // window, and caching it would keep reporting an outage that has
      // ended -- or a "no telemetry" answer for a source that has it.
      if (result.kind === "ok") {
        USAGE_TELEMETRY_CACHE.set(key, {
          result,
          expiresAt: now() + ttlMs
        });
      }
      return result;
    },
    (error: unknown) => {
      // A read that threw is not cached either, but the callers waiting on
      // it still share it: the failure they all see is one failure, not one
      // per caller.
      USAGE_TELEMETRY_IN_FLIGHT.delete(key);
      throw error;
    }
  );
  USAGE_TELEMETRY_IN_FLIGHT.set(key, read);
  return read;
}

/**
 * Drop every cached and in-flight read.
 *
 * The cache is process-wide, so a test that reads telemetry would otherwise
 * see the previous test's answer. Clearing it is the same shape as
 * `clearPrefetchCacheForTests` in the navigation link: a named, explicit
 * way to reset a process-wide cache for a test, and nothing else.
 */
export function clearUsageTelemetryCacheForTests(): void {
  USAGE_TELEMETRY_CACHE.clear();
  USAGE_TELEMETRY_IN_FLIGHT.clear();
}
