/** Memory categories have distinct lifecycles and must not be collapsed into generic text records. */
export const MEMORY_KINDS = ["episodic", "semantic", "procedural"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = [
  "proposed",
  "active",
  "superseded",
  "invalidated",
  "uncertain"
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_REASON_CODES = [
  "candidate_submitted",
  "revised_after_review",
  "verified_current_state",
  "promoted_to_skill",
  "verification_inconclusive",
  "current_state_conflict",
  "superseded_by_newer_evidence",
  "invalidated_by_curator",
  "stale",
  "contradicted",
  "superseded",
  "low_relevance",
  "uncertain",
  "rejected",
  "scope_mismatch",
  "missing_provenance",
  "invalidated",
  "unknown"
] as const;
export type MemoryReasonCode = (typeof MEMORY_REASON_CODES)[number];

export type MemoryValidationState =
  "unverified" | "verified" | "uncertain" | "contradicted";

/**
 * Scope is explicit and hierarchical. Task and agent scopes are run-bound so
 * private working findings cannot silently become cross-task knowledge.
 */
export type MemoryScope =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | {
      readonly kind: "repository";
      readonly workspaceId: string;
      readonly repositoryId: string;
    }
  | {
      readonly kind: "role";
      readonly workspaceId: string;
      readonly role: string;
      readonly repositoryId?: string;
    }
  | {
      readonly kind: "task";
      readonly workspaceId: string;
      readonly taskId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "agent";
      readonly workspaceId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly agentId: string;
    };

export interface MemoryReadContext {
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly role?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  /** Global reads are an explicit grant, not implied by missing scope metadata. */
  readonly canReadGlobal: boolean;
  /** Curator-only, workspace-bounded access to prior task/agent experiences. */
  readonly canReadTaskHistory?: boolean;
}

/** Returns whether a record's scope is visible to the current task/agent context. */
export function isMemoryScopeVisibleTo(
  scope: MemoryScope,
  context: MemoryReadContext
): boolean {
  switch (scope.kind) {
    case "global": {
      return context.canReadGlobal;
    }
    case "workspace": {
      return scope.workspaceId === context.workspaceId;
    }
    case "repository": {
      return (
        scope.workspaceId === context.workspaceId &&
        scope.repositoryId === context.repositoryId
      );
    }
    case "role": {
      return (
        scope.workspaceId === context.workspaceId &&
        scope.role === context.role &&
        (scope.repositoryId === undefined ||
          scope.repositoryId === context.repositoryId)
      );
    }
    case "task": {
      return (
        scope.workspaceId === context.workspaceId &&
        scope.taskId === context.taskId &&
        scope.runId === context.runId
      );
    }
    case "agent": {
      return (
        scope.workspaceId === context.workspaceId &&
        scope.taskId === context.taskId &&
        scope.runId === context.runId &&
        scope.agentId === context.agentId
      );
    }
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

export type MemoryAuthority = "worker" | "root" | "curator" | "system";

export interface MemoryActor {
  readonly id: string;
  readonly authority: MemoryAuthority;
  readonly role?: string;
}

export type ExperienceOutcome =
  "success" | "partial" | "failure" | "cancelled" | "unknown";

export interface EvidenceReference {
  readonly kind:
    | "trajectory"
    | "trace"
    | "file"
    | "commit"
    | "pull_request"
    | "issue"
    | "rule"
    | "skill"
    | "document"
    | "other";
  /** Stable URI or provider-owned reference; payloads belong in their source system. */
  readonly uri: string;
  readonly revision?: string;
  readonly observedAt?: string;
}

/**
 * An append-only envelope around a normalized native transcript. It retains
 * references and execution metadata rather than duplicating prompts or tool
 * payloads in the memory database.
 */
export interface ExperienceEnvelope {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly scope: MemoryScope;
  readonly taskId: string;
  readonly runId: string;
  readonly taskKind?: string;
  readonly taskReference?: EvidenceReference;
  readonly planReference?: EvidenceReference;
  readonly agentId: string;
  readonly agentRole?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly branch?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: ExperienceOutcome;
  readonly validation?: {
    readonly state: "passed" | "failed" | "partial" | "not_run";
    readonly evidence: readonly EvidenceReference[];
  };
  readonly trajectory: {
    readonly format: string;
    readonly uri: string;
    readonly digest?: string;
    readonly recordCount?: number;
  };
  readonly evidence: readonly EvidenceReference[];
}

/**
 * Raw task/agent trajectories stay run-private by default. An explicit trusted
 * curator grant may inspect history within its selected workspace/repository;
 * this does not widen durable MemoryRecord visibility.
 */
export function isMemoryExperienceVisibleTo(
  experience: ExperienceEnvelope,
  context: MemoryReadContext
): boolean {
  if (isMemoryScopeVisibleTo(experience.scope, context)) return true;
  if (
    !context.canReadTaskHistory ||
    (experience.scope.kind !== "task" && experience.scope.kind !== "agent") ||
    experience.workspaceId !== context.workspaceId
  ) {
    return false;
  }
  return (
    context.repositoryId === undefined ||
    experience.repositoryId === context.repositoryId
  );
}

export interface MemoryProvenance {
  readonly experienceIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly verificationSource?: string;
  readonly lastVerifiedAt?: string;
}

export interface MemoryValidity {
  readonly state: MemoryValidationState;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly checkedAt?: string;
  readonly verificationSource?: string;
  readonly evidence: readonly EvidenceReference[];
}

/** A durable claim or procedure derived from one or more raw experiences. */
export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly claim: string;
  readonly status: MemoryStatus;
  readonly provenance: MemoryProvenance;
  readonly validity: MemoryValidity;
  readonly supersedes?: readonly string[];
  readonly supersededBy?: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemorySearchRequest {
  readonly query: string;
  readonly context: MemoryReadContext;
  readonly kinds?: readonly MemoryKind[];
  readonly relevantPaths?: readonly string[];
  /** Soft prior only; matching source experiences must be visible in context. */
  readonly taskKind?: string;
  /** Optional provider-generated embedding; dimensions must match stored vectors. */
  readonly queryEmbedding?: readonly number[];
  readonly limit?: number;
  readonly asOf?: string;
}

export interface MemorySearchHit {
  readonly memory: MemoryRecord;
  readonly score: number;
  readonly matchedSignals: readonly (
    | "lexical"
    | "semantic"
    | "path"
    | "task_kind"
    | "entity"
    | "lineage"
    | "utility"
    | "recency"
  )[];
}

export type MemoryReviewDisposition =
  "retain" | "revise" | "reject" | "uncertain";

/** Task-time reconstruction; the source memory itself remains unchanged. */
export interface ReconstructedMemory {
  readonly memoryId: string;
  readonly disposition: MemoryReviewDisposition;
  readonly guidance?: string;
  readonly rationale: string;
  readonly evidence: readonly EvidenceReference[];
}

export interface MemoryPacket {
  readonly taskId: string;
  readonly entries: readonly ReconstructedMemory[];
  readonly text: string;
  readonly characterCount: number;
  readonly tokenCount?: number;
  readonly omittedCount: number;
  readonly generatedAt: string;
}

export interface MemoryListRequest {
  readonly context: MemoryReadContext;
  readonly query?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface ExperienceListRequest {
  readonly context: MemoryReadContext;
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Bounded retention scan for completed, unreferenced task experiences. */
export interface MemoryExpiredExperienceRequest {
  readonly context: MemoryReadContext;
  readonly completedBefore: string;
  readonly limit: number;
}

export interface MemoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type MemoryExperiencePurgeReason =
  "privacy_request" | "retention_expired";

export interface MemoryExperiencePurgeRequest {
  readonly experienceId: string;
  readonly context: MemoryReadContext;
  readonly eventId: string;
  readonly actorId: string;
  readonly reason: MemoryExperiencePurgeReason;
  readonly occurredAt: string;
}

export type MemoryExperiencePurgeResult =
  "purged" | "not_visible" | "referenced_by_memory";

export interface ExperienceSearchRequest {
  readonly query: string;
  readonly context: MemoryReadContext;
  readonly limit?: number;
}

export interface MemoryVersionedUpdate {
  readonly expectedUpdatedAt: string;
  readonly next: MemoryRecord;
}

export type MemoryLifecycleAction =
  | "proposed"
  | "verified"
  | "revised"
  | "invalidated"
  | "superseded"
  | "promoted"
  | "procedure_promoted";

/** Append-only provenance for every governance decision. */
export interface MemoryLifecycleEvent {
  readonly id: string;
  readonly memoryId: string;
  readonly action: MemoryLifecycleAction;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly fromStatus?: MemoryStatus;
  readonly toStatus: MemoryStatus;
  readonly reasonCode: MemoryReasonCode;
  readonly evidence: readonly EvidenceReference[];
  readonly relatedMemoryIds: readonly string[];
}

export interface MemoryHistory {
  readonly memory: MemoryRecord;
  readonly relatedMemories: readonly MemoryRecord[];
  readonly events: readonly MemoryLifecycleEvent[];
}

export interface MemoryWhyResult extends MemoryHistory {
  readonly sourceExperiences: readonly ExperienceEnvelope[];
}

/** Infrastructure-independent persistence contract owned by Core. */
export interface MemoryRepository {
  /** Append raw execution metadata; implementations must reject duplicate IDs. */
  appendExperience(experience: ExperienceEnvelope): Promise<void>;
  getExperience(
    id: string,
    context: MemoryReadContext
  ): Promise<ExperienceEnvelope | null>;
  searchExperiences(
    request: ExperienceSearchRequest
  ): Promise<readonly ExperienceEnvelope[]>;
  listExperiences(
    request: ExperienceListRequest
  ): Promise<MemoryPage<ExperienceEnvelope>>;
  /** Selects a bounded, scope-visible batch of completed experiences before the policy cutoff. */
  listExpiredExperiences(
    request: MemoryExpiredExperienceRequest
  ): Promise<readonly ExperienceEnvelope[]>;
  /** Privacy/retention erasure of an unreferenced raw experience, with a tombstone. */
  purgeExperience(
    request: MemoryExperiencePurgeRequest
  ): Promise<MemoryExperiencePurgeResult>;

  /** Durable claims enter storage only as proposals. */
  proposeMemory(
    candidate: MemoryRecord,
    event: MemoryLifecycleEvent,
    embedding?: readonly number[]
  ): Promise<void>;
  getMemory(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryRecord | null>;
  searchMemories(
    request: MemorySearchRequest
  ): Promise<readonly MemorySearchHit[]>;
  listMemories(request: MemoryListRequest): Promise<MemoryPage<MemoryRecord>>;
  getMemoryHistory(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryHistory | null>;

  /**
   * Compare-and-set all lifecycle changes atomically. This keeps status and
   * supersession links consistent when one memory replaces another.
   */
  transitionMemories(
    changes: readonly MemoryVersionedUpdate[],
    events: readonly MemoryLifecycleEvent[]
  ): Promise<boolean>;
}

/** Current task content is transient input to JIT research and is never stored as a memory record. */
export interface MemoryResearchRequest {
  readonly taskId: string;
  readonly task: string;
  readonly query: string;
  readonly context: MemoryReadContext;
  readonly kinds?: readonly MemoryKind[];
  readonly relevantPaths?: readonly string[];
  readonly taskKind?: string;
  readonly asOf?: string;
  readonly maxPacketCharacters: number;
  readonly maxPacketTokens?: number;
}
