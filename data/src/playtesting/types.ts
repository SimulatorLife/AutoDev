/** Query filters and pagination envelopes owned by Data; domain artifacts are Core-owned. */

import type {
  HumanPlaytestStudy,
  PlaytestBatch,
  PlaytestBatchState,
  PlaytestBenchmark,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestEpisodeState,
  PlaytestExperiment,
  PlaytestExperimentState,
  PlaytestFinding
} from "@simulatorlife/autodev-core";

/** Filters accepted by list/count queries; workspace scope is mandatory. */
export interface PlaytestBatchFilter {
  readonly workspaceId: string;
  readonly buildSha?: string;
  readonly status?: PlaytestBatchState;
}

export interface PlaytestEpisodeFilter {
  readonly workspaceId: string;
  readonly batchId?: string;
  readonly buildSha?: string;
  readonly scenario?: string;
  readonly policy?: string;
  readonly cohort?: string;
  readonly status?: PlaytestEpisodeState;
  readonly gameOutcome?: PlaytestEpisode["outcome"];
  readonly reviewStatus?: "reviewed" | "unreviewed";
  readonly startedAtFrom?: string;
  readonly startedAtTo?: string;
}

export interface PlaytestFindingFilter {
  readonly workspaceId: string;
  readonly severity?: PlaytestFinding["severity"];
  readonly status?: PlaytestFinding["status"];
  readonly verificationStage?: PlaytestFinding["verificationStage"];
  readonly evidenceStatus?: PlaytestFinding["evidenceStatus"];
}

export interface PlaytestComparisonFilter {
  readonly workspaceId: string;
  readonly benchmarkId?: string;
  readonly experimentId?: string;
  readonly decision?: PlaytestComparison["decision"];
}

export interface PlaytestBenchmarkFilter {
  readonly workspaceId: string;
  readonly referenceBuildSha?: string;
  readonly measurementVersion?: string;
}

export interface PlaytestExperimentFilter {
  readonly workspaceId: string;
  readonly benchmarkId?: string;
  readonly state?: PlaytestExperimentState;
}

export interface PlaytestHumanStudyFilter {
  readonly workspaceId: string;
  readonly benchmarkId?: string;
  readonly instrument?: HumanPlaytestStudy["instrument"];
  readonly approved?: boolean;
}

export interface PlaytestPage<Row> {
  readonly rows: readonly Row[];
  /** Full matching population after filters, never the loaded page size. */
  readonly total: number;
  readonly nextCursor: string | null;
}

/** Narrow page aliases keep list methods' public return types discoverable. */
export type PlaytestBatchPage = PlaytestPage<PlaytestBatch>;
export type PlaytestEpisodePage = PlaytestPage<PlaytestEpisode>;
export type PlaytestFindingPage = PlaytestPage<PlaytestFinding>;
export type PlaytestComparisonPage = PlaytestPage<PlaytestComparison>;
export type PlaytestBenchmarkPage = PlaytestPage<PlaytestBenchmark>;
export type PlaytestExperimentPage = PlaytestPage<PlaytestExperiment>;
export type PlaytestHumanStudyPage = PlaytestPage<HumanPlaytestStudy>;

/** Non-identifying native item result summary within an aggregated human study. */
export interface PlaytestHumanItemAggregate {
  readonly itemId: string;
  readonly mean: number | null;
  readonly respondentCount: number;
  readonly missingCount: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly unit: string;
  readonly missingReasons: readonly string[];
}

/** Already-aggregated, non-identifying summary record persisted to Data. */
export interface PlaytestHumanAggregateRecord {
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly benchmarkId?: string | null;
  readonly buildSha?: string | null;
  readonly instrument: string;
  readonly measurementVersion: string;
  /** Number of retained consenting participants contributing to this aggregate. */
  readonly retainedParticipants: number;
  /** Set to true when participant withdrawal or tombstone revision removes/invalidates the summary. */
  readonly isTombstone?: boolean;
  readonly items: readonly PlaytestHumanItemAggregate[];
  readonly createdAt: string;
}

/** Suppressed human summary returned to Console when retained participants < 5. */
export interface PlaytestHumanSuppressedSummary {
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly benchmarkId: string | null;
  readonly buildSha: string | null;
  readonly instrument: string;
  readonly measurementVersion: string;
  readonly suppressionState: "suppressed";
  readonly suppressionReason: "small-cell-privacy-retained-participants-under-5";
  readonly createdAt: string;
}

/** Unsuppressed human summary returned to Console when retained participants >= 5. */
export interface PlaytestHumanActiveSummary {
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly benchmarkId: string | null;
  readonly buildSha: string | null;
  readonly instrument: string;
  readonly measurementVersion: string;
  readonly suppressionState: "unsuppressed";
  readonly retainedParticipants: number;
  readonly items: readonly PlaytestHumanItemAggregate[];
  readonly createdAt: string;
}

/** Read model returned to Console/Compare for human validation results. */
export type PlaytestHumanValidationSummary =
  PlaytestHumanSuppressedSummary | PlaytestHumanActiveSummary;
