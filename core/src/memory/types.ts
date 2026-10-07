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

export const MEMORY_USE_KINDS = [
  "used",
  "partially_used",
  "not_used",
  "unobservable"
] as const;
/**
 * Bounded kind of a curator-assessed observation of whether an actually
 * injected memory packet was used. This is a reported assessment, never
 * inferred from assistant output, retrieval, or provider success; absence
 * of a report means "unassessed", not "not_used".
 */
export type MemoryUseKind = (typeof MEMORY_USE_KINDS)[number];

export function isMemoryUseKind(value: unknown): value is MemoryUseKind {
  return (
    typeof value === "string" &&
    MEMORY_USE_KINDS.includes(value as MemoryUseKind)
  );
}

export const MEMORY_USE_REPORT_REASON_CODES = [
  "reporter_supplied",
  "reporter_unobservable"
] as const;
export type MemoryUseReportReasonCode =
  (typeof MEMORY_USE_REPORT_REASON_CODES)[number];

export function isMemoryUseReportReasonCode(
  value: unknown
): value is MemoryUseReportReasonCode {
  return (
    typeof value === "string" &&
    MEMORY_USE_REPORT_REASON_CODES.includes(value as MemoryUseReportReasonCode)
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

/**
 * Append-only, curator-assessed observation of whether an actually injected
 * memory packet was used. Distinct from `MemoryOutcomeReport`: a use report
 * never claims task/PR/issue success and is never inferred from assistant
 * output. It is internally keyed by `(workspaceId, correlationToken)`,
 * exactly like `MemoryOutcomeReport`; the `injectionEventId` field is
 * carried for direct reference by API callers that resolved the target
 * event by id rather than by its content-free correlation token. Only an
 * `injected` event with non-empty `memoryIds` is eligible for a use report.
 */
export interface MemoryUseReport {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly scope: MemoryScope;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentRole?: string;
  readonly injectionEventId: string;
  readonly correlationToken: string;
  readonly useKind: MemoryUseKind;
  /**
   * Subset of the matched injection event's `memoryIds`. Must equal every
   * injected id for `"used"`, a non-empty strict subset for
   * `"partially_used"`, and be empty for `"not_used"`/`"unobservable"`.
   */
  readonly usedMemoryIds: readonly string[];
  readonly reportedAt: string;
  readonly reporterId: string;
  /** Only `"root"` or `"curator"` reporters may author a use report. */
  readonly reporterAuthority: MemoryAuthority;
  readonly reasonCode: MemoryUseReportReasonCode;
  /** Required (at least one `"trajectory"` reference) for every kind except `"unobservable"`. */
  readonly evidence: readonly EvidenceReference[];
}

/**
 * Validates the use-kind/usedMemoryIds/evidence invariants against the
 * matched injection event. Implementations call this at the Data boundary
 * so a caller cannot bypass it by skipping the MemoryService layer; Runtime
 * additionally checks that a trajectory evidence URI matches the captured
 * ExperienceEnvelope trajectory, which this function cannot see.
 */
export function assertMemoryUseReportInvariants(
  report: Pick<
    MemoryUseReport,
    "repositoryId" | "useKind" | "usedMemoryIds" | "evidence" | "reasonCode"
  >,
  event: Pick<
    MemoryInjectionEvent,
    "injectionResult" | "memoryMode" | "memoryIds"
  >
): void {
  if (
    event.injectionResult !== "injected" ||
    event.memoryIds.length === 0 ||
    !isMemoryUseCohortEligibleMode(event.memoryMode)
  ) {
    throw new TypeError(
      "Use reports require an eligible injected event with a non-empty packet in jit or retrieval-only mode."
    );
  }
  if (!report.repositoryId?.trim()) {
    throw new TypeError("Use reports require a repository id.");
  }
  if (!isMemoryUseKind(report.useKind)) {
    throw new TypeError("Use report useKind is invalid.");
  }
  if (!isMemoryUseReportReasonCode(report.reasonCode)) {
    throw new TypeError("Use report reasonCode is invalid.");
  }
  const expectedReason =
    report.useKind === "unobservable"
      ? "reporter_unobservable"
      : "reporter_supplied";
  if (report.reasonCode !== expectedReason) {
    throw new TypeError("Use report reasonCode does not match useKind.");
  }
  assertMemoryUseIdsMatchKind(
    report.useKind,
    report.usedMemoryIds,
    event.memoryIds
  );
  assertMemoryUseEvidence(report.useKind, report.evidence);
}

function assertMemoryUseIdsMatchKind(
  useKind: MemoryUseKind,
  usedIds: readonly string[],
  packetIds: readonly string[]
): void {
  if (new Set(usedIds).size !== usedIds.length) {
    throw new TypeError(
      "Use report usedMemoryIds must not contain duplicates."
    );
  }
  const packetIdSet = new Set(packetIds);
  if (usedIds.some((id) => !packetIdSet.has(id))) {
    throw new TypeError(
      "Use report usedMemoryIds must be a subset of the injected memoryIds."
    );
  }
  switch (useKind) {
    case "used": {
      if (usedIds.length !== packetIds.length) {
        throw new TypeError(
          "'used' reports must cite every injected memory id."
        );
      }
      break;
    }
    case "partially_used": {
      if (usedIds.length === 0 || usedIds.length >= packetIds.length) {
        throw new TypeError(
          "'partially_used' reports require a non-empty strict subset of injected memory ids."
        );
      }
      break;
    }
    case "not_used":
    case "unobservable": {
      if (usedIds.length > 0) {
        throw new TypeError(
          `'${useKind}' reports must not cite any memory id.`
        );
      }
      break;
    }
  }
}

function assertMemoryUseEvidence(
  useKind: MemoryUseKind,
  evidence: readonly EvidenceReference[]
): void {
  if (useKind === "unobservable") return;
  if (
    !evidence.some(
      (reference) =>
        reference.kind === "trajectory" && reference.uri.trim().length > 0
    )
  ) {
    throw new TypeError(
      `'${useKind}' reports require a trajectory evidence reference.`
    );
  }
}

function normalizeEvidenceReferences(
  refs: readonly EvidenceReference[]
): string[] {
  return refs
    .map((ref) => `${ref.kind}\u0000${ref.uri}\u0000${ref.revision ?? ""}`)
    .sort();
}

/**
 * True when two evidence arrays carry the same references as a *set*.
 *
 * Every report kind makes the same retry-versus-conflict decision from this,
 * so the semantics live in one place: a reporter that resubmits the same
 * references in a different array order, or with an individual reference's
 * keys in a different insertion order, is retrying the same body and must not
 * be reported as a conflict.
 *
 * Do not compare evidence with `JSON.stringify`. That is a structural
 * comparison wearing a set comparison's clothes: it is sensitive to both key
 * order and array order, and it treats `{ a: undefined }` and `{}` as the same
 * value. `isDeepStrictEqual` is no better here, because it also compares the
 * arrays positionally.
 */
function evidenceSetsMatch(
  a: readonly EvidenceReference[],
  b: readonly EvidenceReference[]
): boolean {
  if (a.length !== b.length) return false;
  const normalizedA = normalizeEvidenceReferences(a);
  const normalizedB = normalizeEvidenceReferences(b);
  return normalizedA.every((value, index) => value === normalizedB[index]);
}

/**
 * True when two use reports for the same injection carry the same
 * `useKind`, `usedMemoryIds` set, and evidence set (ignoring identity/
 * timing fields); used to decide whether a retry is an idempotent no-op or
 * a genuine conflict.
 */
export function useReportBodyMatches(
  a: MemoryUseReport,
  b: MemoryUseReport
): boolean {
  if (a.useKind !== b.useKind) return false;
  if (a.usedMemoryIds.length !== b.usedMemoryIds.length) return false;
  const aIds = [...a.usedMemoryIds].sort();
  const bIds = [...b.usedMemoryIds].sort();
  if (!aIds.every((id, index) => id === bIds[index])) return false;
  return evidenceSetsMatch(a.evidence, b.evidence);
}

export interface MemoryRecordUseReportInput {
  readonly report: MemoryUseReport;
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
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

export interface MemoryInjectionUseJoin {
  readonly injection: MemoryInjectionEvent;
  /** Null when the stored injection has not yet received a curator-assessed use report. */
  readonly use: MemoryUseReport | null;
  /**
   * Count of all injection events captured for the same session key as
   * `injection`, inclusive of `injection` itself. Derived at read time from
   * the full append-only event set for that session; mirrors
   * `MemoryInjectionOutcomeJoin.sessionInjectionCount`.
   */
  readonly sessionInjectionCount: number;
}

export interface MemoryInjectionUseJoinRequest {
  readonly context: MemoryReadContext;
  readonly memoryModes?: readonly MemoryExecutionMode[];
  readonly injectionResults?: readonly MemoryInjectionResult[];
  readonly useKinds?: readonly MemoryUseKind[];
  /**
   * Default false. When false, only injection events with a matching
   * curator-assessed use report are returned. When true, rows whose `use`
   * is null are also surfaced so unassessed exposures can be audited.
   */
  readonly includeUnassessed?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MemoryInjectionUseJoinPage {
  readonly items: readonly MemoryInjectionUseJoin[];
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
 * Append-only, session-level task outcome report. Exactly one report may
 * exist per trusted (workspace, repository, task) session key. This is a
 * distinct table/contract from the per-injection `MemoryOutcomeReport`
 * above, not a wrapper or alias over it: it is a separate session-level
 * task outcome source for ablation analysis. The body is limited to
 * `reportKind`, `outcomeKind`, and `evidence`; reporter identity and
 * authority are derived only from the recording actor, never from
 * caller-supplied fields.
 */
export interface MemorySessionOutcomeReport {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly taskId: string;
  readonly outcomeKind: ExperienceOutcome;
  readonly reportKind: MemoryOutcomeReportKind;
  readonly reportedAt: string;
  readonly reporterId: string;
  readonly reporterAuthority: MemoryAuthority;
  readonly reasonCode: MemoryOutcomeReportReasonCode;
  /** Empty only when `outcomeKind === "unknown"`. */
  readonly evidence: readonly EvidenceReference[];
}

export interface MemoryRecordSessionOutcomeReportInput {
  readonly report: MemorySessionOutcomeReport;
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
}

export interface MemoryRecordSessionOutcomeReportResult {
  readonly appended: boolean;
  readonly id: string;
}

/**
 * The reporter-supplied fields an outcome-shaped report must agree on for a
 * retry to count as the same body. `MemoryOutcomeReport` and
 * `MemorySessionOutcomeReport` differ only in the identity and join fields,
 * which are deliberately not part of the comparison.
 */
interface OutcomeReportBody {
  readonly outcomeKind: ExperienceOutcome;
  readonly reportKind: MemoryOutcomeReportKind;
  readonly evidence: readonly EvidenceReference[];
}

function outcomeReportBodiesMatch(
  a: OutcomeReportBody,
  b: OutcomeReportBody
): boolean {
  if (a.outcomeKind !== b.outcomeKind || a.reportKind !== b.reportKind) {
    return false;
  }
  return evidenceSetsMatch(a.evidence, b.evidence);
}

/**
 * True when two session outcome reports carry the same `reportKind`,
 * `outcomeKind`, and evidence set (ignoring identity/timing fields); used
 * to decide whether a retry is an idempotent no-op or a genuine conflict.
 */
export function sessionOutcomeReportBodyMatches(
  a: MemorySessionOutcomeReport,
  b: MemorySessionOutcomeReport
): boolean {
  return outcomeReportBodiesMatch(a, b);
}

/**
 * True when two outcome reports for the same `(workspace_id,
 * correlation_token)` key carry an identical reporter-supplied body, used to
 * distinguish a safe, idempotent same-body retry from a genuine conflicting
 * report for the same injection. This is the third of the three report kinds
 * that make that decision; all three share `evidenceSetsMatch`, so a retry is
 * judged the same way whichever report kind it arrives as.
 */
export function outcomeReportBodyMatches(
  a: MemoryOutcomeReport,
  b: MemoryOutcomeReport
): boolean {
  return outcomeReportBodiesMatch(a, b);
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
 * Whether an experience's outcome was verified, and how far.
 *
 * Distinct from `MemoryValidationState` above, which describes how much a stored
 * *claim* has been corroborated; this describes how far an *execution's* result
 * was checked. Named rather than left inline so the Console can key its
 * vocabulary tables by the union instead of `string`: a `Record<string, …>` tone
 * map silently accepts any state, renders a raw wire key as the operator-facing
 * word (`not_run`, underscore and all, in one of two places that showed it), and
 * makes the next state the Runtime adds a typecheck failure nobody sees until it
 * ships.
 */
export type ExperienceValidationState =
  "passed" | "failed" | "partial" | "not_run";

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
    readonly state: ExperienceValidationState;
    readonly evidence: readonly EvidenceReference[];
  };
  readonly trajectory: {
    readonly format: string;
    readonly uri: string;
    readonly digest?: string;
    readonly recordCount?: number;
    /**
     * Vendor-neutral identifier of the adapter/source that normalized this
     * transcript generation (for example `"codex"` or `"claude-code"`).
     * Optional: historical rows captured before this field existed, and
     * manually appended envelopes, never fabricate a value here.
     */
    readonly sourceAdapter?: string;
    /**
     * Vendor-neutral identifier of the normalizer package used, carried as
     * an opaque string (Core has no dependency on, or knowledge of, the
     * Runtime-selected normalizer implementation). Optional for the same
     * reason as `sourceAdapter`.
     */
    readonly normalizerId?: string;
    /** Exact normalizer package version string. Optional for the same reason as `sourceAdapter`. */
    readonly normalizerVersion?: string;
    /**
     * Distinct, lexicographically sorted diagnostic codes emitted while
     * normalizing this generation. Codes only: normalization diagnostic
     * free-text detail, transcript records, and other transcript content
     * must never be persisted here. Optional for the same reason as
     * `sourceAdapter`.
     */
    readonly diagnosticCodes?: readonly string[];
  };
  readonly evidence: readonly EvidenceReference[];
}

/** Maximum distinct normalization diagnostics retained with a trajectory. */
export const MAX_TRAJECTORY_DIAGNOSTIC_CODES = 64;

/**
 * Validates the optional native-capture provenance on a trajectory
 * reference. Provenance is either wholly absent (manual/historical envelope)
 * or complete (native capture). Diagnostic codes must be distinct and
 * lexicographically sorted so persisted provenance is stable rather than
 * depending on normalizer emission order.
 */
export function assertTrajectoryProvenance(
  trajectory: ExperienceEnvelope["trajectory"]
): void {
  const fields = [
    trajectory.sourceAdapter,
    trajectory.normalizerId,
    trajectory.normalizerVersion,
    trajectory.diagnosticCodes
  ];
  const present = fields.filter((field) => field !== undefined).length;
  if (present === 0) return;
  if (present !== fields.length) {
    throw new TypeError(
      "Trajectory provenance fields must be populated together."
    );
  }

  for (const [name, value] of [
    ["sourceAdapter", trajectory.sourceAdapter],
    ["normalizerId", trajectory.normalizerId],
    ["normalizerVersion", trajectory.normalizerVersion]
  ] as const) {
    if (!value?.trim()) {
      throw new TypeError(`Trajectory ${name} must not be empty.`);
    }
  }

  const codes = trajectory.diagnosticCodes!;
  if (codes.length > MAX_TRAJECTORY_DIAGNOSTIC_CODES) {
    throw new TypeError(
      `Trajectory diagnosticCodes exceeds the maximum of ${MAX_TRAJECTORY_DIAGNOSTIC_CODES}.`
    );
  }
  if (codes.some((code) => !code.trim())) {
    throw new TypeError("Trajectory diagnosticCodes must not be empty.");
  }
  const sorted = [...codes].sort();
  const isSortedAndDistinct =
    codes.length === new Set(codes).size &&
    codes.every((code, index) => code === sorted[index]);
  if (!isSortedAndDistinct) {
    throw new TypeError(
      "Trajectory diagnosticCodes must be distinct and lexicographically sorted."
    );
  }
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
  /**
   * Inclusive lower bound on when a record entered the store, matching the
   * column its own listing is ordered by. Supplied together with
   * `occurredUntil`, or not at all -- a half-open window is not a window.
   */
  readonly occurredFrom?: string;
  readonly occurredUntil?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ExperienceListRequest {
  readonly context: MemoryReadContext;
  readonly query?: string;
  readonly memoryModes?: readonly MemoryExecutionMode[];
  readonly outcomes?: readonly ExperienceOutcome[];
  /**
   * Inclusive bounds on when an experience *started*.
   *
   * Not on `completed_at`: that column is NULL while a session is still
   * running, so filtering the experience list by it would silently hide every
   * in-flight session from an operator reading the tab for current work. The
   * Console's window describes when the work happened, and a started_at NULL
   * cannot exist.
   */
  readonly occurredFrom?: string;
  readonly occurredUntil?: string;
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

/**
 * How many records sit at each lifecycle status, over the whole filtered
 * collection.
 *
 * Every status is present, including the ones with no rows. A partial map would
 * force every reader to ask whether a missing key means zero or means not
 * observed, and this codebase has a rule about never confusing those two -- so
 * the ambiguity is removed here rather than left to each consumer.
 */
export type MemoryStatusCounts = Readonly<Record<MemoryStatus, number>>;

/**
 * A page of records, plus the lifecycle breakdown of everything they were drawn
 * from.
 *
 * The breakdown is over the filtered collection, not over the rows on the page,
 * because the page is a window the reader chose and the collection is the thing
 * the number is about. Deriving it client-side from the rows was the defect this
 * type exists to end: on a 25-row page it reported at most 25 active claims
 * beside a total of 1,204, which reads as a share and is not one.
 */
export interface MemoryRecordPage extends MemoryPage<MemoryRecord> {
  readonly statusCounts: MemoryStatusCounts;
}

/** A status rollup with every status present, so no consumer has to infer zero. */
export function emptyMemoryStatusCounts(): MemoryStatusCounts {
  return Object.fromEntries(
    MEMORY_STATUSES.map((status) => [status, 0])
  ) as MemoryStatusCounts;
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return (
    typeof value === "string" &&
    (MEMORY_STATUSES as readonly string[]).includes(value)
  );
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
  listMemories(
    request: MemoryListRequest
  ): Promise<MemoryRecordPage>;
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
   * Session-scoped lookup by the injection event's own `id`, mirroring
   * `findInjectionEventByTokenForSession`'s (workspace, repository, task)
   * join but keyed by id instead of the opaque correlationToken. Used by
   * the external use-report API, which accepts only `injectionEventId`
   * from the browser and must resolve the event's correlationToken/scope
   * itself rather than trusting a caller-supplied token.
   */
  getInjectionEventByIdForSession(
    context: MemoryInjectionEventSessionLookup,
    injectionEventId: string
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

  /**
   * Append-only, curator-assessed use report attached to an observed
   * `injected` event with non-empty `memoryIds`, within the same
   * (workspace, repository, task) session scope as
   * `recordOutcomeReport`. Implementations reject reports whose target
   * correlationToken has no scope-aligned injection event, reject a
   * reporter authority other than root/curator, and enforce the
   * use-kind/usedMemoryIds/evidence invariants documented on
   * `assertMemoryUseReportInvariants` at the Data boundary. A same-body
   * retry for the same (workspace_id, correlation_token) key is
   * idempotent; a conflicting retry is rejected.
   */
  recordInjectionUseReport(
    input: MemoryRecordUseReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }>;
  /** Returns the single use report for a (workspace, correlationToken) key, or null. */
  getInjectionUseReport(
    workspaceId: string,
    correlationToken: string
  ): Promise<MemoryUseReport | null>;
  /**
   * Scoped, filtered join between stored injection events and their
   * curator-assessed use reports. Rows without a matching use report
   * return `use: null`; mirrors `listInjectionOutcomeJoins`.
   */
  listInjectionUseJoins(
    request: MemoryInjectionUseJoinRequest
  ): Promise<MemoryInjectionUseJoinPage>;
  /**
   * Workspace/repository/time-scoped GROUP BY aggregate over the canonical
   * append-only injection event table and its curator-assessed use
   * reports, at the per-injection exposure unit. Distinct from
   * `aggregateInjectionOutcomeCohorts`: the denominator is restricted to
   * `injected` events with non-empty `memoryIds` (every other event is
   * excluded, not merely zero-filled), and cells group only by
   * `(memoryMode, sessionCardinality, useKind)` -- there is no
   * `injectionResult` or `reportKind` dimension. Cells whose `useKind` is
   * null represent an eligible exposure that has not yet received a
   * curator assessment. `sessionCardinality` is derived from the full,
   * unfiltered event set for each row's session key, never from the
   * `memoryModes`/`useKinds` filters applied to this read, and never
   * excluding sibling events outside the injected/non-empty denominator.
   * Implementations must parameterize every bound as `$n`-style
   * placeholders and never include correlation tokens, session/task/run/
   * agent IDs, memory IDs, evidence URIs, or reporter identities in the
   * response.
   */
  aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage>;

  /**
   * Append-only, session-level task outcome keyed uniquely by
   * (workspace_id, repository_id, task_id). Distinct from
   * `recordOutcomeReport`'s per-injection-token table: this is a separate
   * task-outcome source for ablation analysis, not a wrapper or fan-out of
   * per-injection reports. Implementations must require a repository
   * scope, require at least one recorded injection event for the session
   * key, require non-empty evidence for any non-"unknown" outcomeKind,
   * derive reporter identity/authority only from `actor`, and treat an
   * identical-body retry as idempotent while rejecting a conflicting-body
   * retry for the same session key.
   */
  recordSessionOutcomeReport(
    input: MemoryRecordSessionOutcomeReportInput
  ): Promise<MemoryRecordSessionOutcomeReportResult>;
  /** Returns the single session outcome report for a session key, or null. */
  getSessionOutcomeReport(
    workspaceId: string,
    repositoryId: string,
    taskId: string
  ): Promise<MemorySessionOutcomeReport | null>;

  /**
   * Workspace/repository/time-scoped GROUP BY aggregate over the canonical
   * append-only injection event table and the session outcome report
   * table, at the unique session key (workspace, repository, task) unit --
   * distinct from `aggregateInjectionOutcomeCohorts`'s per-exposure unit.
   *
   * Implementations must:
   * - parameterize every bound (workspace, repository, occurred window,
   *   bounded enum filters) as `$n`-style placeholders;
   * - select the observed session population as sessions with at least one
   *   in-window injection event matching the optional memoryMode/
   *   injectionResult filters;
   * - derive each selected session's mode from its complete, unfiltered
   *   injection-event set: a single distinct mode maps to that mode, and
   *   more than one distinct mode maps to "mixed"; filters never change
   *   this full-session classification;
   * - represent a session as a cell only when its full-session mode is a
   *   single assigned mode (jit/retrieval-only/disabled); mixed-mode
   *   sessions are excluded from cells and counted only in
   *   mixedModeSessionCount, and sessions whose full-session mode is a
   *   single "invalid" or "unknown" mode are excluded from this
   *   response entirely -- never coerced into the "disabled" cell or
   *   counted anywhere in this aggregate;
   * - count unique sessions (sessionCount, reportedSessionCount,
   *   unreportedSessionCount, mixedModeSessionCount); sessionCount sums
   *   only the single-assigned-mode cells;
   * - derive conflictingOutcomeSessionCount as a diagnostic from
   *   per-injection-token report disagreement for each selected session
   *   (excluding invalid/unknown-only sessions); it never overrides the
   *   canonical session outcome report and may overlap with
   *   mixedModeSessionCount;
   * - join each selected session to at most one session outcome report and
   *   group cells by (memoryMode, outcomeKind), keeping unreported cells
   *   (null outcomeKind) explicit rather than dropping them;
   * - never include task/session ids, evidence URIs, reporter identities,
   *   or request-exposure counts in the response; exposure counts remain
   *   the responsibility of aggregateInjectionOutcomeCohorts.
   */
  aggregateSessionOutcomeCohorts(
    request: MemorySessionOutcomeCohortFilter
  ): Promise<MemorySessionOutcomeCohortPage>;
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

/**
 * Maximum allowed injection-time window for a single Memory read.
 *
 * Named for what it bounds rather than for the route that first needed it: the
 * cohort reads, the session-outcome cohorts, and the use cohorts all carry this
 * ceiling, and the records and experiences listings now bound their time filter
 * with it too. One ceiling means an operator gets the same answer for "how far
 * back can I look" on every Memory surface instead of learning a different bound
 * per tab.
 */
export const MEMORY_MAX_TIME_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

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
  if (untilMs - fromMs > MEMORY_MAX_TIME_WINDOW_MS) {
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

export interface MemoryInjectionUseCohortFilter {
  readonly context: MemoryReadContext;
  /** Inclusive lower bound on injection `occurred_at`. Required, ≤365 days from `occurredUntil`. */
  readonly occurredFrom: string;
  /** Inclusive upper bound on injection `occurred_at`. Required, ≥`occurredFrom`. */
  readonly occurredUntil: string;
  /** Optional bounded enum filter. Unspecified values surface every bounded mode. */
  readonly memoryModes?: readonly MemoryUseCohortAssignedMode[];
  /** Optional bounded enum filter on the *curator-assessed* use kind. */
  readonly useKinds?: readonly MemoryUseKind[];
}

export const MEMORY_USE_COHORT_ASSIGNED_MODES = [
  MEMORY_EXECUTION_MODES[0],
  MEMORY_EXECUTION_MODES[1],
  MEMORY_EXECUTION_MODES[2]
] as const;
export type MemoryUseCohortAssignedMode =
  (typeof MEMORY_USE_COHORT_ASSIGNED_MODES)[number];

export const MEMORY_USE_COHORT_ELIGIBLE_MODES = [
  MEMORY_EXECUTION_MODES[0],
  MEMORY_EXECUTION_MODES[1]
] as const;
export type MemoryUseCohortEligibleMode =
  (typeof MEMORY_USE_COHORT_ELIGIBLE_MODES)[number];

export function isMemoryUseCohortEligibleMode(
  value: unknown
): value is MemoryUseCohortEligibleMode {
  return (
    typeof value === "string" &&
    (MEMORY_USE_COHORT_ELIGIBLE_MODES as readonly string[]).includes(value)
  );
}

export interface MemoryInjectionUseCohortCell {
  readonly memoryMode: MemoryUseCohortEligibleMode;
  /**
   * `"single"` when every injection event grouped into this cell belongs to
   * a session that captured exactly one injection event in total (derived
   * from the full, unfiltered event set); `"multiple"` otherwise.
   */
  readonly sessionCardinality: MemoryInjectionSessionCardinality;
  /** Null when the cell represents an eligible-but-unassessed exposure. */
  readonly useKind: MemoryUseKind | null;
  /** Count of eligible (`injected`, non-empty memoryIds) exposures in this group; an integer ≥ 0. */
  readonly exposureCount: number;
}

export interface MemoryInjectionUseCohortPage {
  readonly schema: "autodev-memory-injection-use-cohorts-v1";
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
  readonly cells: readonly MemoryInjectionUseCohortCell[];
  /** Sum of `exposureCount` across cells; equals total eligible injection events seen. */
  readonly exposureCount: number;
}

/**
 * Validate a use cohort filter at the MemoryService/Data boundary so
 * unbounded scans are never issued against the canonical event tables.
 */
export function assertMemoryInjectionUseCohortFilter(
  filter: MemoryInjectionUseCohortFilter
): void {
  if (!filter.context.workspaceId.trim()) {
    throw new TypeError("Use cohort filter requires a workspace id.");
  }
  if (
    filter.context.repositoryId === undefined ||
    !filter.context.repositoryId.trim()
  ) {
    throw new TypeError("Use cohort filter requires a repository id.");
  }
  if (
    filter.context.role !== undefined ||
    filter.context.taskId !== undefined ||
    filter.context.runId !== undefined ||
    filter.context.agentId !== undefined
  ) {
    throw new TypeError(
      "Use cohort filters cannot select a role, task, run, or agent."
    );
  }
  const fromMs = Date.parse(filter.occurredFrom);
  const untilMs = Date.parse(filter.occurredUntil);
  if (!Number.isFinite(fromMs)) {
    throw new TypeError("Use cohort filter 'from' is not a valid timestamp.");
  }
  if (!Number.isFinite(untilMs)) {
    throw new TypeError("Use cohort filter 'until' is not a valid timestamp.");
  }
  if (untilMs < fromMs) {
    throw new TypeError(
      "Use cohort filter 'until' must be greater than or equal to 'from'."
    );
  }
  if (untilMs - fromMs > MEMORY_MAX_TIME_WINDOW_MS) {
    throw new TypeError(
      "Use cohort filter window exceeds the 365-day maximum."
    );
  }
  if (
    filter.memoryModes !== undefined &&
    filter.memoryModes.some(
      (mode) =>
        !(MEMORY_USE_COHORT_ASSIGNED_MODES as readonly string[]).includes(mode)
    )
  ) {
    throw new TypeError("Use cohort filter memoryMode is invalid.");
  }
  if (
    filter.useKinds !== undefined &&
    filter.useKinds.some((kind) => !isMemoryUseKind(kind))
  ) {
    throw new TypeError("Use cohort filter useKind is invalid.");
  }
}

export const MEMORY_SESSION_COHORT_ASSIGNED_MODES = [
  "jit",
  "retrieval-only",
  "disabled"
] as const;

export type MemorySessionCohortAssignedMode =
  (typeof MEMORY_SESSION_COHORT_ASSIGNED_MODES)[number];

export function isMemorySessionCohortAssignedMode(
  value: unknown
): value is MemorySessionCohortAssignedMode {
  return (
    typeof value === "string" &&
    (MEMORY_SESSION_COHORT_ASSIGNED_MODES as readonly string[]).includes(value)
  );
}

export interface MemorySessionOutcomeCohortFilter {
  readonly context: MemoryReadContext;
  /** Inclusive lower bound on injection occurred_at. Required, <= 365 days from occurredUntil. */
  readonly occurredFrom: string;
  /** Inclusive upper bound on injection occurred_at. Required, >= occurredFrom. */
  readonly occurredUntil: string;
  /** Optional bounded assigned-mode filter applied only to in-window session selection. */
  readonly memoryModes?: readonly MemorySessionCohortAssignedMode[];
  /** Optional bounded injection-result filter applied only to in-window session selection. */
  readonly injectionResults?: readonly MemoryInjectionResult[];
  /** Optional bounded report-kind filter applied to the joined session outcome report. */
  readonly reportKinds?: readonly MemoryOutcomeReportKind[];
  /** Optional bounded outcome-kind filter applied to the joined session outcome report. */
  readonly outcomeKinds?: readonly ExperienceOutcome[];
}

export interface MemorySessionOutcomeCohortCell {
  /**
   * One of the three full-session single assigned modes. Mixed-mode
   * sessions (more than one distinct mode in the full session) and
   * invalid/unknown-only sessions are never represented as a cell: mixed
   * sessions are counted only in `mixedModeSessionCount`, and
   * invalid/unknown-only sessions are excluded from this response
   * entirely -- never coerced into the "disabled" cell.
   */
  readonly memoryMode: MemorySessionCohortAssignedMode;
  /** Null when no session outcome report exists for sessions in this cell. */
  readonly outcomeKind: ExperienceOutcome | null;
  /** Unique session count for this cell. */
  readonly sessionCount: number;
}

export interface MemorySessionOutcomeCohortPage {
  readonly schema: "autodev-memory-session-outcome-cohorts-v1";
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
  readonly cells: readonly MemorySessionOutcomeCohortCell[];
  /**
   * Sum of cell sessionCount: unique, full-session single-assigned-mode
   * (jit/retrieval-only/disabled) sessions observed in the filtered
   * population. Excludes mixed-mode sessions (see
   * `mixedModeSessionCount`) and invalid/unknown-only sessions, which
   * this response never surfaces.
   */
  readonly sessionCount: number;
  readonly reportedSessionCount: number;
  readonly unreportedSessionCount: number;
  /**
   * Diagnostic count of sessions whose per-injection token reports
   * disagree on outcome; derived from the distinct per-injection
   * `memory_outcome_reports` rows for the session's correlation
   * tokens. This never overrides the canonical session outcome report
   * above and may overlap with `mixedModeSessionCount`.
   */
  readonly conflictingOutcomeSessionCount: number;
  readonly mixedModeSessionCount: number;
}

export function assertMemorySessionOutcomeCohortFilter(
  filter: MemorySessionOutcomeCohortFilter
): void {
  if (!filter.context.workspaceId.trim()) {
    throw new TypeError("Session cohort filter requires a workspace id.");
  }
  if (
    filter.context.repositoryId === undefined ||
    !filter.context.repositoryId.trim()
  ) {
    throw new TypeError("Session cohort filter requires a repository id.");
  }
  if (
    filter.context.role !== undefined ||
    filter.context.taskId !== undefined ||
    filter.context.runId !== undefined ||
    filter.context.agentId !== undefined
  ) {
    throw new TypeError(
      "Session cohort filters cannot select a role, task, run, or agent."
    );
  }
  const fromMs = Date.parse(filter.occurredFrom);
  const untilMs = Date.parse(filter.occurredUntil);
  if (!Number.isFinite(fromMs)) {
    throw new TypeError(
      "Session cohort filter 'from' is not a valid timestamp."
    );
  }
  if (!Number.isFinite(untilMs)) {
    throw new TypeError(
      "Session cohort filter 'until' is not a valid timestamp."
    );
  }
  if (untilMs < fromMs) {
    throw new TypeError(
      "Session cohort filter 'until' must be greater than or equal to 'from'."
    );
  }
  if (untilMs - fromMs > MEMORY_MAX_TIME_WINDOW_MS) {
    throw new TypeError(
      "Session cohort filter window exceeds the 365-day maximum."
    );
  }
  if (
    filter.memoryModes !== undefined &&
    filter.memoryModes.some((mode) => !isMemorySessionCohortAssignedMode(mode))
  ) {
    throw new TypeError("Session cohort filter memoryMode is invalid.");
  }
  if (
    filter.injectionResults !== undefined &&
    filter.injectionResults.some((value) => !isMemoryInjectionResult(value))
  ) {
    throw new TypeError("Session cohort filter injectionResult is invalid.");
  }
  if (
    filter.reportKinds !== undefined &&
    filter.reportKinds.some((kind) => !isMemoryOutcomeReportKind(kind))
  ) {
    throw new TypeError("Session cohort filter reportKind is invalid.");
  }
  if (
    filter.outcomeKinds !== undefined &&
    filter.outcomeKinds.some((kind) => !EXPERIENCE_OUTCOMES.includes(kind))
  ) {
    throw new TypeError("Session cohort filter outcomeKind is invalid.");
  }
}
