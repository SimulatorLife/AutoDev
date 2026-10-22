/** Query filters and pagination envelopes owned by Data; domain artifacts are Core-owned. */

import type {
  HumanPlaytestStudy,
  PlaytestArtifactReference,
  PlaytestBatch,
  PlaytestBatchState,
  PlaytestBenchmark,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestEpisodeState,
  PlaytestEvidenceLocator,
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

/** Durable batch-history facts needed to reconcile local packet artifacts. */
export interface PlaytestBatchArtifactState {
  readonly latestStatus: PlaytestBatchState | null;
  /** Packet references appearing in any persisted batch revision. */
  readonly packetArtifacts: readonly PlaytestArtifactReference[];
}

/** Durable identity for a client launch attempt, separate from game evidence. */
export interface PlaytestLaunchIntent {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly launchIntentHash: string;
  readonly batchId: string;
  readonly assignmentCount: number;
  readonly createdAt: string;
  /** Retry identity expires before ClickHouse retention removes the receipt. */
  readonly expiresAt: string;
}

export interface PlaytestEpisodeFilter {
  readonly workspaceId: string;
  /**
   * Free-text search over the session's own identity.
   *
   * The session id, the batch it belongs to, its scenario, its policy and
   * its cohort: the facts a reader already has when they are looking for
   * one particular session.
   */
  readonly query?: string;
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
  readonly fingerprint?: string;
  readonly severity?: PlaytestFinding["severity"];
  readonly status?: PlaytestFinding["status"];
  readonly verificationStage?: PlaytestFinding["verificationStage"];
  readonly evidenceStatus?: PlaytestFinding["evidenceStatus"];
}

/**
 * Filters accepted by the persisted-review list. Workspace scope is
 * mandatory; discovery and confirmatory reviews share one table and are
 * told apart by the schema their payload carries.
 */
export interface PlaytestReviewListFilter {
  readonly workspaceId: string;
  /** Restrict to one episode. */
  readonly episodeId?: string;
  /** Restrict to one review kind. */
  readonly kind?: "discovery" | "confirmatory";
}

/**
 * One finding the analyst recorded, with the evidence status it carries.
 *
 * The status is the part an operator needs: a finding whose evidence was never
 * reproduced is still a candidate, and a reader has to be able to tell a
 * candidate from a verified defect without opening the archive.
 */
export interface PlaytestReviewFindingSummary {
  readonly findingId: string;
  readonly title: string;
  readonly evidenceStatus: PlaytestFinding["evidenceStatus"];
}

/**
 * One claim the analyst recorded, with the status it carries.
 *
 * A review claims two kinds of thing: something the analyst asserts, and
 * something the analyst explicitly could not confirm. The payload records the
 * second kind as a claim with the `not observed` status, so it would be wrong
 * to read every recorded claim as an asserted conclusion.
 */
export interface PlaytestReviewClaimSummary {
  readonly hypothesisId: string;
  readonly text: string;
  /** "hypothesis" for an asserted claim, "not observed" for an explicit null. */
  readonly status: "hypothesis" | "not observed";
}

/**
 * One persisted analyst review, projected down to what a list row can hold.
 * The full canonical payload stays in the archive; this is the durable
 * record of what the analyst concluded about an episode.
 */
export interface PlaytestReviewSummary {
  readonly reviewId: string;
  readonly episodeId: string;
  readonly workspaceId: string;
  readonly kind: "discovery" | "confirmatory";
  /** ISO timestamp. */
  readonly createdAt: string;
  /** The review's own status, verbatim from the payload. */
  readonly status: string;
  readonly observationCount: number;
  readonly interpretationCount: number;
  readonly findingCount: number;
  /** A one-line, human-readable statement of what the analyst concluded. */
  readonly headline: string;
  /** The review's chronological summary, bounded. */
  readonly summary: string;
  /**
   * The analyst's interpretations, in the order the review recorded them.
   *
   * The count alone was not enough: a reader who sees "5 hypotheses" still
   * cannot read what the analyst claimed, and the claims are the review.
   */
  readonly hypotheses: readonly PlaytestReviewClaimSummary[];
  /** The findings the review carries, with each one's evidence status. */
  readonly findings: readonly PlaytestReviewFindingSummary[];
  /** The evidence the review cites, deduplicated and bounded. */
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
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
