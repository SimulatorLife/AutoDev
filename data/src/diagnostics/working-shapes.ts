/**
 * The mutable working shapes the diagnostics engine builds.
 *
 * The published contract in `@simulatorlife/autodev-core` is readonly: a
 * consumer receives facts, not a structure it can edit. The engine, on the
 * other hand, accumulates -- a thread's turns, a session's token totals, a
 * router provider's counters -- and every one of those is filled field by
 * field before it is published.
 *
 * These are the two shapes that reconcile: the engine works on the mutable
 * mirror, and the mirror is assignable to the readonly contract at the
 * boundary.
 */

import type {
  FleetSessionRow,
  RecentSessionSummary,
  SessionInvestigation,
  SessionRouterProviderStats,
  SessionThreadGap,
  SessionThreadItem,
  SessionThreadTurn,
  SessionToolFailure
} from "@simulatorlife/autodev-core";

/** The writable mirror of a published type. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type MutableInvestigation = Omit<
  Mutable<SessionInvestigation>,
  "context"
> & {
  context: { ccc: number; cgc: number; lsp: number };
};
export type MutableTurn = Mutable<SessionThreadTurn>;
export type MutableGap = Mutable<SessionThreadGap>;
export type MutableItem = Mutable<SessionThreadItem>;
export type MutableFailure = Mutable<SessionToolFailure>;
export type MutableProviderStats = Mutable<SessionRouterProviderStats>;
export type MutableFleetRow = Omit<Mutable<FleetSessionRow>, "routerSkipped" | "providers"> & {
  routerSkipped: Record<string, number>;
  providers: Record<string, number>;
};
export type MutableRecentSession = Mutable<RecentSessionSummary>;
