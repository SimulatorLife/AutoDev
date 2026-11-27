import type {
  ControlApiLiveAgentCounts,
  UsageActiveSessions,
  UsageMetricsData
} from "@simulatorlife/autodev-core";

import type { QuotaExhaustionEvidence } from "../providers/ProviderQuota.ts";

/** One source's outcome. Only `ok` carries data; the others carry why not. */
export type OverviewRead<T> =
  | { readonly status: "ok"; readonly data: T }
  | {
      readonly status: "not-configured" | "unavailable";
      readonly code: string;
      readonly message: string;
    };

export interface OverviewLiveActivity {
  readonly activeSessions: UsageActiveSessions;
  /** `null`: the Runtime registered no agent-activity source. */
  readonly liveAgents: ControlApiLiveAgentCounts | null;
}

export interface OverviewProviderVerdicts {
  readonly total: number;
  readonly ready: number;
  /** `null` when the quota report has no usable fresh evidence: not observed, not zero. */
  readonly quotaExhausted: number | null;
  readonly notObserved: number;
  /** Failing health or cooldown, excluding quota exhaustion. */
  readonly unavailable: number;
  /** Disabled, unrouted, missing credential or signed out. */
  readonly needsAttention: number;
  /** Quality of the quota evidence behind `quotaExhausted`. */
  readonly quotaEvidence: QuotaExhaustionEvidence;
}

interface OverviewFailingSession {
  readonly id: string;
  readonly lastWrite: string;
  readonly toolFailures: number;
  readonly routerFailures: number;
}

export interface OverviewFailures {
  readonly scannedSessions: number;
  readonly scanLimit: number;
  readonly toolFailures: number;
  readonly routerFailures: number;
  readonly failingSessions: readonly OverviewFailingSession[];
  readonly failingSessionCount: number;
}

export interface OverviewData {
  readonly liveActivity: OverviewRead<OverviewLiveActivity>;
  readonly providers: OverviewRead<OverviewProviderVerdicts>;
  readonly failures: OverviewRead<OverviewFailures>;
  readonly telemetry: OverviewRead<UsageMetricsData>;
}
