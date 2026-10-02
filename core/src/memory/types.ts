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

export const EXPERIENCE_OUTCOMES = [
  "success",
  "partial",
  "failure",
  "cancelled",
  "unknown"
] as const;
export type ExperienceOutcome = (typeof EXPERIENCE_OUTCOMES)[number];

/** Host-selected memory policy for the task that produced this experience. */
export const MEMORY_EXECUTION_MODES = [
  "jit",
  "retrieval-only",
  "disabled",
  "invalid",
  "unknown"
] as const;
export type MemoryExecutionMode = (typeof MEMORY_EXECUTION_MODES)[number];

export function isMemoryExecutionMode(
  value: unknown
): value is MemoryExecutionMode {
  return (
    typeof value === "string" &&
    MEMORY_EXECUTION_MODES.includes(value as MemoryExecutionMode)
  );
}

/** Parse an externally reported mode without treating an invalid value as a valid cohort. */
export function parseMemoryExecutionMode(
  value: unknown,
  ablationEnabled = false
): MemoryExecutionMode {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const mode = value.trim();
  if (!isMemoryExecutionMode(mode)) return "invalid";
  return mode === "retrieval-only" && !ablationEnabled ? "invalid" : mode;
}

/** Categorical injection decision: bounded for storage and metric dimensions. */
export const MEMORY_INJECTION_RESULTS = [
  "injected",
  "empty",
  "skipped"
] as const;
export type MemoryInjectionResult = (typeof MEMORY_INJECTION_RESULTS)[number];

/** Bounded kind of an independently reporter-supplied task/PR/issue outcome. */
export const MEMORY_OUTCOME_REPORT_KINDS = [
  "task",
  "pull_request",
  "issue",
  "other"
] as const;
export type MemoryOutcomeReportKind =
  (typeof MEMORY_OUTCOME_REPORT_KINDS)[number];

/**
 * Bounded cardinality of a captured session's injection events: whether the
 * session (workspace, repository, task/session id) emitted exactly one
 * injection event or more than one. Derived at read time from the full
 * event set for that session; it carries no request/thread run or agent
 * identity and is not evidence of task success, memory use, or reliable
 * per-turn attribution.
 */
export const MEMORY_INJECTION_SESSION_CARDINALITIES = [
  "single",
  "multiple"
] as const;
export type MemoryInjectionSessionCardinality =
  (typeof MEMORY_INJECTION_SESSION_CARDINALITIES)[number];

export const MEMORY_INJECTION_EVENT_REASON_CODES = [
  "packet_attached",
  "no_packet_research_returned_empty",
  "scope_or_authority_unavailable",
  "memory_mode_disabled",
  "memory_mode_invalid",
  "no_trusted_workspace",
  "task_text_unavailable",
  "research_failure",
  "duplicate_injection_token"
] as const;
export type MemoryInjectionEventReasonCode =
  (typeof MEMORY_INJECTION_EVENT_REASON_CODES)[number];

export const MEMORY_OUTCOME_REPORT_REASON_CODES = [
  "reporter_supplied",
  "reporter_unknown",
  "missing_evidence",
  "scope_mismatch",
  "duplicate_report",
  "invalid_outcome_kind",
  "invalid_report_kind",
  "untrusted_target_reference"
] as const;
export type MemoryOutcomeReportReasonCode =
  (typeof MEMORY_OUTCOME_REPORT_REASON_CODES)[number];

export function isMemoryInjectionResult(
  value: unknown
): value is MemoryInjectionResult {
  return (
    typeof value === "string" &&
    MEMORY_INJECTION_RESULTS.includes(value as MemoryInjectionResult)
  );
}

export function isMemoryOutcomeReportKind(
  value: unknown
): value is MemoryOutcomeReportKind {
  return (
    typeof value === "string" &&
    MEMORY_OUTCOME_REPORT_KINDS.includes(value as MemoryOutcomeReportKind)
  );
}

export function isMemoryInjectionSessionCardinality(
  value: unknown
): value is MemoryInjectionSessionCardinality {
  return (
    typeof value === "string" &&
    MEMORY_INJECTION_SESSION_CARDINALITIES.includes(
      value as MemoryInjectionSessionCardinality
    )
  );
}

export function isMemoryInjectionEventReasonCode(
  value: unknown
): value is MemoryInjectionEventReasonCode {
  return (
    typeof value === "string" &&
    MEMORY_INJECTION_EVENT_REASON_CODES.includes(
      value as MemoryInjectionEventReasonCode
    )
  );
}

export function isMemoryOutcomeReportReasonCode(
  value: unknown
): value is MemoryOutcomeReportReasonCode {
  return (
    typeof value === "string" &&
    MEMORY_OUTCOME_REPORT_REASON_CODES.includes(
      value as MemoryOutcomeReportReasonCode
    )
  );
}

/**
 * Append-only observation of the moment the runtime actually decided whether
 * to attach a memory packet to a routed request. The durable
 * `correlationToken` is opaque, contains no prompt or transcript content, and
 * is intentionally not propagated into metric dimensions or model prompts;
 * it exists solely so a later reporter-supplied outcome can be joined back to
 * the exact captured task/session scope without rewriting the raw
 * `ExperienceEnvelope` row.
 */
export interface MemoryInjectionEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly scope: MemoryScope;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentRole?: string;
  /** Durable, content-free correlation identifier; never enters prompt or metrics. */
  readonly correlationToken: string;
  readonly memoryMode: MemoryExecutionMode;
  readonly injectionResult: MemoryInjectionResult;
  readonly packetCharacterCount: number;
  readonly packetTokenCount?: number;
  /** Bounded references to the durable memories that were attached; no prompt content. */
  readonly memoryIds: readonly string[];
  readonly occurredAt: string;
  readonly reasonCode: MemoryInjectionEventReasonCode;
  readonly evidence: readonly EvidenceReference[];
  /** Identity of the runtime component that appended this event. */
  readonly recordedBy: string;
}

/**
 * Append-only, reporter-supplied outcome attached to an observed injection.
 * It is never inferred from retrieval, provider success, or the presence of a
 * PR/issue link. Non-`unknown` outcomes must arrive with at least one bounded
 * evidence reference and a `correlationToken` that matches a previously
 * persisted injection event in the exact (workspace, repository, task, run,
 * agent) scope; the Control API enforces that scope match fails closed.
 */
export interface MemoryOutcomeReport {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly scope: MemoryScope;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentRole?: string;
  readonly correlationToken: string;
  readonly outcomeKind: ExperienceOutcome;
  readonly reportKind: MemoryOutcomeReportKind;
  readonly reportedAt: string;
  readonly reporterId: string;
  readonly reporterAuthority: MemoryAuthority;
  readonly reasonCode: MemoryOutcomeReportReasonCode;
  /** Empty only when `outcomeKind === "unknown"`. */
  readonly evidence: readonly EvidenceReference[];
}

/** One observed injection joined to its reporter-supplied outcome, if any. */
export interface MemoryInjectionOutcomeJoin {
  readonly injection: MemoryInjectionEvent;
  /** Null when the stored injection has not yet been reported. */
  readonly outcome: MemoryOutcomeReport | null;
  /**
   * Count of all injection events captured for the same session key
   * (workspace, repository, task/session id) as `injection`, inclusive of
   * `injection` itself. Derived at read time from the full append-only
   * event set for that session -- memory-mode, injection-result, report-kind,
   * and outcome-kind filters applied to the surrounding query never change
   * this count. It distinguishes a session that injected exactly once from
   * one that injected repeatedly; it does not attribute any request/thread
   * runId or agentId to the session-level outcome, and it is not evidence
   * that the model read or relied on any injected packet.
   */
  readonly sessionInjectionCount: number;
}

export interface MemoryInjectionOutcomeJoinRequest {
  readonly context: MemoryReadContext;
  readonly memoryModes?: readonly MemoryExecutionMode[];
  readonly injectionResults?: readonly MemoryInjectionResult[];
  readonly outcomeKinds?: readonly ExperienceOutcome[];
  readonly reportKinds?: readonly MemoryOutcomeReportKind[];
  /**
   * Default false. When false, only injection events with a matching
   * reporter-supplied outcome are returned (success-cohort style reads).
   * When true, rows whose `outcome` is null are also surfaced so they can be
   * accounted for in unreported-tokens audits.
   */
  readonly includeUnreported?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MemoryInjectionOutcomeJoinPage {
  readonly items: readonly MemoryInjectionOutcomeJoin[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface MemoryRecordInjectionEventInput {
  readonly event: MemoryInjectionEvent;
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
}

export interface MemoryRecordOutcomeReportInput {
  readonly report: MemoryOutcomeReport;
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
}

/**
 * Session-level join key. The runtime emits injection events whose `taskId`
 * is the session identity (sessionKey ?? requestId), but whose `runId` and
 * `agentId` are request-level identifiers (requestId, threadId). A reporter-
 * supplied outcome arrives later at the same session scope and resolves the
 * `correlationToken` against this triple only.
 */
export interface MemoryInjectionEventSessionLookup {
  readonly workspaceId: string;
  readonly repositoryId?: string;
  readonly taskId: string;
  /** Reporter-supplied; not part of the join, only used for context diagnostics. */
  readonly runId?: string;
  /** Reporter-supplied; not part of the join, only used for context diagnostics. */
  readonly agentId?: string;
  /** Required for parity with MemoryReadContext but unused in the join predicate. */
  readonly canReadGlobal: boolean;
}

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
  /** Host-selected cohort policy, not proof that a packet was injected. */
  readonly memoryMode?: MemoryExecutionMode;
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
  "retain" | "revise" | "reject" | "uncertain" | "not_evaluated";

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
  readonly memoryModes?: readonly MemoryExecutionMode[];
  readonly outcomes?: readonly ExperienceOutcome[];
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

  /**
   * Append-only record of an actual memory packet injection (or deliberately
   * empty/skipped research result) at the runtime boundary. Implementations
   * reject duplicate `correlationToken` values with a conflict error so the
   * runtime treats re-emitted events as already-recorded rather than
   * overwriting prior observations.
   */
  recordInjectionEvent(
    input: MemoryRecordInjectionEventInput
  ): Promise<{ readonly appended: boolean; readonly id: string }>;
  /**
   * Append-only, reporter-supplied outcome attached to an observed injection
   * event within the same (workspace, repository, task, run, agent) scope.
   * Implementations reject reports that target a correlationToken outside
   * the authorized scope and enforce evidence requirements at the Data
   * boundary rather than relying on caller discipline.
   */
  recordOutcomeReport(
    input: MemoryRecordOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }>;
  /**
   * Scoped, filtered join between stored injection events and their
   * reporter-supplied outcomes. Rows without a matching outcome return
   * `outcome: null`; reports targeting an injection event outside the scope
   * cannot appear here because the report write itself was rejected.
   */
  listInjectionOutcomeJoins(
    request: MemoryInjectionOutcomeJoinRequest
  ): Promise<MemoryInjectionOutcomeJoinPage>;
  /**
   * Session-level injection lookup. Returns the matched injection event when
   * its `(workspace_id, repository_id, task_id)` tuple equals the trusted
   * session scope; `runId` and `agentId` on the row are request-level
   * details and are NOT part of the join, so a single captured session may
   * contain several routed request injections all matchable through this
   * method. Returns null when no scope-aligned injection exists for the
   * supplied token.
   */
  findInjectionEventByTokenForSession(
    context: MemoryInjectionEventSessionLookup,
    correlationToken: string
  ): Promise<MemoryInjectionEvent | null>;

  /**
   * Workspace/repository/time-scoped GROUP BY aggregate over the canonical
   * append-only injection/outcome event tables. The join uses the
   * one-row-per-token unique index on `memory_outcome_reports`, so
   * `reportCount <= exposureCount` is enforced structurally.
   *
   * Implementations must:
   * - parameterize every bound (workspace, repository, occurred window,
   *   bounded enum filters) as `$n`-style placeholders;
   * - reject bad time/enum filters at the Data boundary so unbounded scans
   *   are never issued;
   * - return cells whose `reportKind`/`outcomeKind` are null when no
   *   matching report row exists for an injection event;
   * - derive each cell's `sessionCardinality` from the full, unfiltered
   *   count of injection events sharing that event's session key
   *   (workspace, repository, task/session id); `memoryModes`,
   *   `injectionResults`, `reportKinds`, and `outcomeKinds` filters must
   *   never change which sessions count as `single` vs `multiple`;
   * - never include correlation tokens, session/task/run/agent IDs, memory
   *   IDs, evidence URIs, or reporter identities in the response.
   */
  aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ): Promise<MemoryInjectionOutcomeCohortPage>;
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

/**
 * Bounded aggregate read over canonical append-only injection/outcome event
 * tables. The cohort is grouped by the fixed tuple
 * `(memoryMode, injectionResult, sessionCardinality, reportKind, outcomeKind)`.
 * Cells whose `reportKind`/`outcomeKind` are null represent unreported
 * exposures (an injection event that has not yet received a reporter-
 * supplied outcome); `reportCount` is 0 for those cells and
 * `reportCount <= exposureCount` is structurally guaranteed by the
 * one-row-per-token unique index on the report table. `sessionCardinality`
 * is derived from the full event set for each row's session key, never from
 * the filtered rows contributing to the cohort read itself.
 *
 * Operators query this cohort at the (workspace, repository, time) level.
 * Role/task/run/agent selectors are never accepted from the caller; the
 * request is scoped only to the `(workspace_id, repository_id)` triple the
 * trusted `MemoryReadContext` carries, and its time window is bounded so
 * unbounded scans are never issued against the canonical event tables.
 */
export interface MemoryInjectionOutcomeCohortFilter {
  readonly context: MemoryReadContext;
  /** Inclusive lower bound on injection `occurred_at`. Required, ≤365 days from `occurredUntil`. */
  readonly occurredFrom: string;
  /** Inclusive upper bound on injection `occurred_at`. Required, ≥`occurredFrom`. */
  readonly occurredUntil: string;
  /** Optional bounded enum filter. Unspecified values surface every bounded mode. */
  readonly memoryModes?: readonly MemoryExecutionMode[];
  /** Optional bounded enum filter. Unspecified values surface every bounded injection result. */
  readonly injectionResults?: readonly MemoryInjectionResult[];
  /** Optional bounded enum filter on the *reporter-supplied* outcome kind. */
  readonly outcomeKinds?: readonly ExperienceOutcome[];
  /** Optional bounded enum filter on the *reporter-supplied* report kind. */
  readonly reportKinds?: readonly MemoryOutcomeReportKind[];
}

export interface MemoryInjectionOutcomeCohortCell {
  readonly memoryMode: MemoryExecutionMode;
  readonly injectionResult: MemoryInjectionResult;
  /**
   * `"single"` when every injection event grouped into this cell belongs to
   * a session (workspace, repository, task/session id) that captured exactly
   * one injection event in total; `"multiple"` when that session captured
   * more than one. Derived from the full, unfiltered event set for the
   * session -- never from the `memoryModes`/`injectionResults`/
   * `reportKinds`/`outcomeKinds` filters applied to this cohort read.
   */
  readonly sessionCardinality: MemoryInjectionSessionCardinality;
  /** Null when the cell represents an unreported exposure (no matching report row). */
  readonly reportKind: MemoryOutcomeReportKind | null;
  /** Null when the cell represents an unreported exposure (no matching report row). */
  readonly outcomeKind: ExperienceOutcome | null;
  /** Count of injection events in this group; an integer ≥ 0. */
  readonly exposureCount: number;
  /** Count of joined reports in this group; 0 ≤ reportCount ≤ exposureCount. */
  readonly reportCount: number;
}

export interface MemoryInjectionOutcomeCohortPage {
  readonly schema: "autodev-memory-injection-outcome-cohorts-v1";
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
  readonly cells: readonly MemoryInjectionOutcomeCohortCell[];
  /** Sum of `exposureCount` across cells; equals total injection events seen. */
  readonly exposureCount: number;
  /** Sum of `reportCount` across cells; equals total joined report rows; ≤ exposureCount. */
  readonly reportCount: number;
}

/** Maximum allowed injection-time window for a single cohort read. */
export const MEMORY_OUTCOME_COHORT_MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Validate a cohort filter at the MemoryService/Data boundary so unbounded
 * scans are never issued against the canonical event tables.
 */
export function assertMemoryInjectionOutcomeCohortFilter(
  filter: MemoryInjectionOutcomeCohortFilter
): void {
  if (!filter.context.workspaceId.trim()) {
    throw new TypeError("Cohort filter requires a workspace id.");
  }
  if (
    filter.context.repositoryId === undefined ||
    !filter.context.repositoryId.trim()
  ) {
    throw new TypeError("Cohort filter requires a repository id.");
  }
  if (
    filter.context.role !== undefined ||
    filter.context.taskId !== undefined ||
    filter.context.runId !== undefined ||
    filter.context.agentId !== undefined
  ) {
    throw new TypeError(
      "Cohort filters cannot select a role, task, run, or agent."
    );
  }
  const fromMs = Date.parse(filter.occurredFrom);
  const untilMs = Date.parse(filter.occurredUntil);
  if (!Number.isFinite(fromMs)) {
    throw new TypeError("Cohort filter 'from' is not a valid timestamp.");
  }
  if (!Number.isFinite(untilMs)) {
    throw new TypeError("Cohort filter 'until' is not a valid timestamp.");
  }
  if (untilMs < fromMs) {
    throw new TypeError(
      "Cohort filter 'until' must be greater than or equal to 'from'."
    );
  }
  if (untilMs - fromMs > MEMORY_OUTCOME_COHORT_MAX_WINDOW_MS) {
    throw new TypeError("Cohort filter window exceeds the 365-day maximum.");
  }
  if (
    filter.memoryModes !== undefined &&
    filter.memoryModes.some((mode) => !isMemoryExecutionMode(mode))
  ) {
    throw new TypeError("Cohort filter memoryMode is invalid.");
  }
  if (
    filter.injectionResults !== undefined &&
    filter.injectionResults.some((value) => !isMemoryInjectionResult(value))
  ) {
    throw new TypeError("Cohort filter injectionResult is invalid.");
  }
  if (
    filter.reportKinds !== undefined &&
    filter.reportKinds.some((kind) => !isMemoryOutcomeReportKind(kind))
  ) {
    throw new TypeError("Cohort filter reportKind is invalid.");
  }
  if (
    filter.outcomeKinds !== undefined &&
    filter.outcomeKinds.some((kind) => !EXPERIENCE_OUTCOMES.includes(kind))
  ) {
    throw new TypeError("Cohort filter outcomeKind is invalid.");
  }
}
