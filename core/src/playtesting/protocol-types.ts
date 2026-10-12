import type { PlaytestAdapterQuotas, PlaytestMissingReason } from "./types.ts";

/** JSON-compatible game state; Runtime validates it against the negotiated schema. */
export type PlaytestJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PlaytestJsonValue[]
  | { readonly [key: string]: PlaytestJsonValue };

export interface PlaytestArtifactReference {
  readonly artifactId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly revision?: number;
}

/** `game.capabilities` is always the first call on a newly started adapter. */
export interface GameCapabilitiesParams {
  readonly protocolVersion: 1;
}

export interface GameResetParams {
  readonly seed: string;
  readonly scenarioId: string;
  readonly approvedVariantHash: string;
}

export interface GameResetResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly rngProvenance: {
    readonly algorithm: string;
    readonly version: string;
    readonly initialStateHash: string | null;
    readonly reproducible: boolean;
  };
}

/** Compact digest for one exact engine state, including RNG when observable. */
export interface GameRngCheckpoint {
  readonly algorithm: string;
  readonly version: string;
  /** Null means the engine cannot expose a stable state for this stream. */
  readonly stateHash: string | null;
  readonly reproducible: boolean;
}

/** Persisted full-state digest and RNG point for one pre-action decision. */
export interface PlaytestCheckpointDigest {
  readonly stateHash: string;
  readonly rngCheckpoint: GameRngCheckpoint;
}

export interface GameEpisodeRevisionParams {
  readonly episodeId: string;
  readonly expectedRevision: number;
}

export interface GameObserveResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly observation: PlaytestJsonValue;
  readonly turnContext: PlaytestJsonValue | null;
  readonly frame: PlaytestArtifactReference | null;
}

export interface GameLegalAction {
  readonly actionId: string;
  readonly description?: string;
  readonly features?: Readonly<Record<string, PlaytestJsonValue>>;
}

export interface GameLegalActionsResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly actions: readonly GameLegalAction[];
}

export interface GameStepParams extends GameEpisodeRevisionParams {
  readonly actionId: string;
}

/** Illegal/stale actions are JSON-RPC errors, never successful rejected steps. */
export interface GameStepResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly acceptedActionId: string;
  readonly eventIds: readonly string[];
  readonly terminal: boolean;
}

/** Game-owned evaluator sufficient statistics for one frozen metric. */
export interface GameMetricEvaluation {
  readonly metricId: string;
  readonly metricVersion: number;
  /** Null for a whole-episode result; otherwise the exact game-owned phase. */
  readonly phaseId: string | null;
  readonly evaluatorRef: string;
  readonly evaluatorHash: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly opportunityCount: number;
  readonly missing: number;
  readonly independentUnits: number;
  readonly unit: string;
  readonly missingReasons: readonly PlaytestMissingReason[];
}

export interface GameOutcomeResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly state: "terminal" | "partial";
  readonly outcome: PlaytestJsonValue | null;
  /** Game-native outcome facts, distinct from rubric-controlled metric rows. */
  readonly metrics: Readonly<Record<string, number | null>>;
  /** Typed sufficient statistics emitted by the approved game evaluator code. */
  readonly evaluations: readonly GameMetricEvaluation[];
  readonly missingReasons: readonly string[];
}

export interface GameInvariantWitness {
  readonly invariantId: string;
  readonly result: "passed" | "failed" | "not-observed";
  readonly witness: PlaytestJsonValue | null;
  readonly diagnostic: string | null;
}

export interface GameInvariantsResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly witnesses: readonly GameInvariantWitness[];
}

export interface GameSnapshotResult {
  readonly episodeId: string;
  readonly revision: number;
  /** Full relevant engine-state digest, including hidden state. */
  readonly stateHash: string;
  readonly rngCheckpoint: GameRngCheckpoint;
  /** Present only when includeArtifact was requested. */
  readonly snapshot: PlaytestArtifactReference | null;
  readonly integrityHash: string | null;
}

export interface GameSnapshotParams extends GameEpisodeRevisionParams {
  /** Digest-only checkpoints avoid writing a large engine image per decision. */
  readonly includeArtifact: boolean;
}

export interface GameReplayParams {
  readonly trace: PlaytestArtifactReference;
  readonly expectedBuildSha: string;
  /** Reconstruct the pre-action state of this zero-based decision. */
  readonly throughStep: number;
}

export interface GameReplayResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly replayStatus: "verified" | "diverged" | "unavailable";
  readonly transitionHash: string | null;
  readonly firstDivergentStep: number | null;
  readonly replayedThroughStep: number;
  readonly stateHash: string | null;
  readonly rngCheckpoint: GameRngCheckpoint;
  readonly diagnostics: readonly string[];
}

export interface GameForkParams {
  readonly snapshot: PlaytestArtifactReference;
  readonly alternativeActionId: string;
  readonly rngPolicy: "same-stream" | "independent-stream" | "declared-policy";
  readonly rngPolicyVersion: string;
}

export interface GameForkResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly initialStateHash: string;
  readonly rngCheckpoint: GameRngCheckpoint;
}

export interface GameCaptureRangeParams extends GameEpisodeRevisionParams {
  readonly startStep: number;
  readonly endStep: number;
}

export interface GameCaptureEvent {
  readonly eventId: string;
  readonly type: string;
  readonly phaseId: string | null;
  readonly step: number;
  readonly revision: number;
  readonly actor: string | null;
  readonly fields: Readonly<Record<string, PlaytestJsonValue>>;
}

export interface GameCaptureEventsResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly events: readonly GameCaptureEvent[];
  readonly omittedCount: number;
}

export interface GameCaptureFrameResult {
  readonly episodeId: string;
  readonly revision: number;
  readonly step: number;
  readonly capturedAt: string;
  readonly artifact: PlaytestArtifactReference;
}

export interface GameCancelParams {
  readonly requestId: string;
}

export interface GameCancelResult {
  readonly requestId: string;
  readonly acknowledged: boolean;
  /** Acknowledgement alone does not establish whether the original operation rolled back. */
  readonly episodeDisposition: "unchanged" | "aborted" | "unknown";
}

export interface GameEventNotificationParams {
  readonly episodeId: string;
  readonly revision: number;
  readonly eventSequence: number;
  readonly event: GameCaptureEvent;
}

export interface GameProgressNotificationParams {
  readonly requestId: string;
  readonly completed: number;
  readonly total: number;
}

/** Negotiated quotas are used by the transport, not by a policy prompt. */
export type GameAdapterQuotaContract = AdapterQuotaBound<PlaytestAdapterQuotas>;
type AdapterQuotaBound<T> = { readonly [K in keyof T]: T[K] };
