import {
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer
} from "@opentelemetry/api";
import {
  assertMemoryInjectionOutcomeCohortFilter,
  assertMemoryInjectionUseCohortFilter,
  assertMemorySessionOutcomeCohortFilter,
  assertMemoryUseReportInvariants,
  assertTrajectoryProvenance,
  type EvidenceReference,
  EXPERIENCE_OUTCOMES,
  type ExperienceEnvelope,
  type ExperienceListRequest,
  type ExperienceSearchRequest,
  isMemoryExecutionMode,
  isMemoryExperienceVisibleTo,
  isMemoryInjectionResult,
  isMemoryOutcomeReportKind,
  isMemoryScopeVisibleTo,
  isMemoryUseKind,
  isMemoryExperiencePurgeReason,
  MEMORY_EXECUTION_MODES,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_REASON_CODES,
  type MemoryActor,
  type MemoryAuthority,
  type MemoryExperiencePurgeReason,
  type MemoryExperiencePurgeResult,
  type MemoryExpiredExperienceRequest,
  type MemoryHistory,
  type MemoryInjectionEvent,
  type MemoryInjectionOutcomeCohortFilter,
  type MemoryInjectionOutcomeCohortPage,
  type MemoryInjectionOutcomeJoinPage,
  type MemoryInjectionOutcomeJoinRequest,
  type MemoryInjectionUseCohortFilter,
  type MemoryInjectionUseCohortPage,
  type MemoryInjectionUseJoinPage,
  type MemoryInjectionUseJoinRequest,
  type MemoryLifecycleAction,
  type MemoryLifecycleEvent,
  type MemoryListRequest,
  type MemoryPacket,
  type MemoryPage,
  type MemoryReadContext,
  type MemoryReasonCode,
  type MemoryRecord,
  type MemoryRecordInjectionEventInput,
  type MemoryRecordOutcomeReportInput,
  type MemoryRecordPage,
  type MemoryRecordSessionOutcomeReportInput,
  type MemoryRepository,
  type MemoryResearchRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemorySessionOutcomeCohortFilter,
  type MemorySessionOutcomeCohortPage,
  type MemorySessionOutcomeReport,
  type MemoryStatus,
  type MemoryUseKind,
  type MemoryUseReport,
  type MemoryVersionedUpdate,
  type MemoryWhyResult
} from "@simulatorlife/autodev-core";
import { MemoryConflictError as RepositoryMemoryConflictError } from "@simulatorlife/autodev-data";

import { redactSensitiveText, sanitizeEvidence } from "./privacy.ts";
import {
  type NativeTrajectorySource,
  type NormalizedTrajectorySummary,
  normalizeNativeTrajectory
} from "./trajectory.ts";

export interface CurrentStateIssueObservation {
  readonly uri: string;
  readonly state: "OPEN" | "CLOSED";
  readonly stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  readonly updatedAt: string;
  readonly observedAt: string;
}

export interface CurrentStateAssessment {
  readonly compatibility: "compatible" | "contradicted" | "unknown";
  readonly source: string;
  readonly checkedAt: string;
  readonly evidence: readonly EvidenceReference[];
  readonly issueObservations?: readonly CurrentStateIssueObservation[];
  readonly reasonCode: MemoryReasonCode;
}

export interface MemoryCurrentStateVerifier {
  verify(input: {
    readonly memory: MemoryRecord;
    readonly task: string;
    readonly context: MemoryReadContext;
    readonly asOf: string;
  }): Promise<CurrentStateAssessment>;
}

export interface MemoryReconstructor {
  reconstruct(input: {
    readonly memory: MemoryRecord;
    readonly task: string;
    readonly assessment: CurrentStateAssessment;
  }): Promise<{
    readonly disposition: "retain" | "revise" | "reject" | "uncertain";
    readonly guidance?: string;
    readonly rationale: string;
  }>;
}

/** Recoverable provider outage; the service continues with lexical retrieval. */
export class MemoryEmbeddingUnavailableError extends Error {
  constructor() {
    super("The optional memory embedding provider is unavailable.");
    this.name = "MemoryEmbeddingUnavailableError";
  }
}

export interface MemoryEmbeddingProvider {
  /** Implemented through AutoDev's existing provider/model layer, not a private router. */
  /** Throw MemoryEmbeddingUnavailableError only when a recoverable provider outage prevents vector generation. */
  embed(text: string): Promise<readonly number[]>;
}

export interface MemoryProposalInput {
  readonly kind: MemoryRecord["kind"];
  readonly scope: MemoryRecord["scope"];
  readonly claim: string;
  readonly experienceIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

export interface MemoryExperienceCaptureInput {
  readonly source: NativeTrajectorySource;
  readonly transcript: string;
  readonly trajectoryUri: string;
  readonly experience: Omit<ExperienceEnvelope, "trajectory" | "startedAt"> & {
    readonly startedAt?: string;
  };
}

export interface MemoryExperienceRetentionReport {
  readonly selected: number;
  readonly purged: number;
  readonly referencedByMemory: number;
  readonly noLongerVisible: number;
}

export interface MemorySkillPromotionInput {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

export interface MemorySkillPromotionArtifact {
  readonly name: string;
  readonly path: string;
  readonly uri: string;
  readonly revision: string;
}

export interface MemorySkillPromotionWriter {
  createSkill(input: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly context: MemoryReadContext;
  }): Promise<MemorySkillPromotionArtifact>;
}

export interface MemoryServiceOptions {
  readonly repository: MemoryRepository;
  readonly verifier: MemoryCurrentStateVerifier;
  readonly reconstructor: MemoryReconstructor;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly countTokens?: (text: string) => number;
  readonly embedder?: MemoryEmbeddingProvider;
  /** Caps expensive task-time reconstruction calls; retrieval remains bounded separately. */
  readonly maxResearchCandidates?: number;
  readonly skillPromotionWriter?: MemorySkillPromotionWriter;
}

const MAX_QUERY_LENGTH = 4000;
const MAX_TASK_KIND_LENGTH = 200;
const MAX_MEMORY_REFERENCE_ID_LENGTH = 256;
const MAX_CLAIM_LENGTH = 4000;
const MAX_RESEARCH_HITS = 40;
const MAX_RESEARCH_CANDIDATES = 40;
const MAX_LIST_OFFSET = 100_000;
const MAX_PACKET_CHARACTERS = 24_000;
const MAX_EXPERIENCE_REFERENCE_COUNT = 64;
const MAX_RETENTION_BATCH_SIZE = 100;
const MIN_VALIDATED_PROMOTION_RUNS = 2;
const MAX_SKILL_DESCRIPTION_LENGTH = 512;
const MAX_SKILL_CONTENT_LENGTH = 20_000;
const MEMORY_SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;

const MAX_INJECTION_MEMORY_IDS = 64;
const MAX_INJECTION_REVISION_LENGTH = 256;
const MAX_INJECTION_URI_LENGTH = 2048;

const MEMORY_OPERATIONS = {
  embed: "memory.embed",
  experienceAppend: "memory.experience.append",
  experiencePurge: "memory.experience.purge",
  experienceRetention: "memory.experience.retention",
  injectionRecord: "memory.injection.record",
  injectionOutcomeList: "memory.injection.outcome.list",
  injectionOutcomeAggregate: "memory.injection.outcome.aggregate",
  injectionUseList: "memory.injection.use.list",
  injectionUseAggregate: "memory.injection.use.aggregate",
  sessionOutcomeAggregate: "memory.session.outcome.aggregate",
  sessionOutcomeReport: "memory.session.outcome.report",
  invalidate: "memory.invalidate",
  outcomeReport: "memory.outcome.report",
  useReport: "memory.use.report",
  packet: "memory.packet",
  promote: "memory.promote",
  propose: "memory.propose",
  query: "memory.query",
  reconstruct: "memory.reconstruct",
  rerank: "memory.rerank",
  research: "memory.research",
  retrieve: "memory.retrieve",
  revise: "memory.revise",
  supersede: "memory.supersede",
  validate: "memory.validate",
  verify: "memory.verify"
} as const;
type MemoryOperationName =
  (typeof MEMORY_OPERATIONS)[keyof typeof MEMORY_OPERATIONS];
type MemoryMetricAttributes = Record<string, string>;

const MEMORY_SPAN_ATTRIBUTES = {
  kind: "memory.kind",
  status: "memory.status",
  validation: "memory.validation"
} as const;

interface MemoryMetricInstruments {
  readonly operations: Counter<MemoryMetricAttributes>;
  readonly operationDuration: Histogram<MemoryMetricAttributes>;
  readonly candidates: Counter<MemoryMetricAttributes>;
  readonly packetCharacters: Histogram<MemoryMetricAttributes>;
  readonly packetTokens: Histogram<MemoryMetricAttributes>;
  readonly outcomeReports: Counter<MemoryMetricAttributes>;
  readonly sessionOutcomeReports: Counter<MemoryMetricAttributes>;
  readonly useReports: Counter<MemoryMetricAttributes>;
}

function recordMemoryMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Telemetry is observational and must never fail a memory operation.
  }
}

/**
 * Session-level visibility for one injection event or outcome report row.
 * These rows are keyed at (workspace, repository, task) session scope;
 * their stored `runId`/`agentId` are request-level identifiers
 * (requestId/threadId) and must never be compared against the reporter's
 * session-level `context.runId`/`context.agentId`. Revealing
 * injections/outcomes across every request and agent within a session
 * requires the explicit curator task-history grant; this intentionally
 * does not widen `isMemoryScopeVisibleTo`, which remains an exact match
 * for ordinary memory records.
 */
function isInjectionOutcomeVisibleToSession(
  row: {
    readonly workspaceId: string;
    readonly repositoryId?: string;
    readonly taskId: string;
  },
  context: MemoryReadContext
): boolean {
  if (!context.canReadTaskHistory) return false;
  if (row.workspaceId !== context.workspaceId) return false;
  if (row.taskId !== context.taskId) return false;
  if (
    context.repositoryId !== undefined &&
    row.repositoryId !== context.repositoryId
  ) {
    return false;
  }
  return true;
}

function createMemoryMetricInstruments(meter: Meter): MemoryMetricInstruments {
  return {
    operations: meter.createCounter("autodev.memory.operations", {
      description: "Memory operations completed by the owning MemoryService.",
      unit: "{operation}"
    }),
    operationDuration: meter.createHistogram(
      "autodev.memory.operation.duration",
      {
        description: "Elapsed time for one MemoryService operation.",
        unit: "s"
      }
    ),
    candidates: meter.createCounter("autodev.memory.candidates", {
      description:
        "Candidate lifecycle observations across memory retrieval, curation, and packet construction.",
      unit: "{candidate}"
    }),
    packetCharacters: meter.createHistogram(
      "autodev.memory.packet.characters",
      {
        description: "Character count of a constructed memory packet.",
        unit: "{character}"
      }
    ),
    packetTokens: meter.createHistogram("autodev.memory.packet.tokens", {
      description: "Token count of a constructed memory packet when available.",
      unit: "{token}"
    }),
    outcomeReports: meter.createCounter("autodev.memory.outcome_reports", {
      description:
        "Newly persisted outcome reports for memory injections, counted only when the report is appended (not on idempotent retries).",
      unit: "{report}"
    }),
    sessionOutcomeReports: meter.createCounter(
      "autodev.memory.session_outcome_reports",
      {
        description:
          "Newly persisted session-level outcome reports, counted only when the report is appended.",
        unit: "{report}"
      }
    ),
    useReports: meter.createCounter("autodev.memory.use_reports", {
      description:
        "Newly persisted curator-assessed injection-use reports, counted only when appended.",
      unit: "{report}"
    })
  };
}

/**
 * Bounded categorical dimensions for the outcome-cohort counter and span.
 * Inputs are the matched `MemoryInjectionEvent` (evidence for memory mode +
 * actual injection result) and the bounded fields of the reporter-supplied
 * outcome report (report kind + outcome kind). Anything outside the bounded
 * enums collapses to "unknown" so cardinality stays low. Sensitive fields
 * (correlationToken, experience/task/run/agent IDs, evidence URIs, claims,
 * target bodies, reporter IDs) are intentionally never included.
 */
interface OutcomeReportCohortAttributes extends MemoryMetricAttributes {
  readonly "autodev.memory.outcome.report_kind": string;
  readonly "autodev.memory.outcome.kind": string;
  readonly "autodev.memory.outcome.memory_mode": string;
  readonly "autodev.memory.outcome.injection_result": string;
}

function recordOutcomeReportCohortAttributes(
  injection: MemoryInjectionEvent,
  report: MemoryRecordOutcomeReportInput["report"]
): OutcomeReportCohortAttributes {
  const injectionResultValue: string = isMemoryInjectionResult(
    injection.injectionResult
  )
    ? injection.injectionResult
    : "unknown";
  const memoryModeValue: string = isMemoryExecutionMode(injection.memoryMode)
    ? injection.memoryMode
    : "unknown";
  const reportKindValue: string = isMemoryOutcomeReportKind(report.reportKind)
    ? report.reportKind
    : "unknown";
  const outcomeKindValue: string = EXPERIENCE_OUTCOMES.includes(
    report.outcomeKind as (typeof EXPERIENCE_OUTCOMES)[number]
  )
    ? report.outcomeKind
    : "unknown";
  return {
    "autodev.memory.outcome.report_kind": reportKindValue,
    "autodev.memory.outcome.kind": outcomeKindValue,
    "autodev.memory.outcome.memory_mode": memoryModeValue,
    "autodev.memory.outcome.injection_result": injectionResultValue
  };
}

function assertInjectionUseReportAccess(
  actor: MemoryActor,
  context: MemoryReadContext
): void {
  if (actor.authority !== "root" && actor.authority !== "curator") {
    throw new MemoryAuthorizationError(
      "Only root or memory curator authorities may record injection-use reports."
    );
  }
  if (context.canReadTaskHistory !== true) {
    throw new MemoryAuthorizationError(
      "Task-history access is required to report injection use."
    );
  }
  if (!context.repositoryId) {
    throw new MemoryAuthorizationError(
      "Repository scope is required to report injection use."
    );
  }
}

function contextForCapturedExperience(
  experience: ExperienceEnvelope,
  canReadTaskHistory: boolean
): MemoryReadContext {
  return {
    workspaceId: experience.workspaceId,
    ...(experience.repositoryId
      ? { repositoryId: experience.repositoryId }
      : {}),
    ...(experience.agentRole ? { role: experience.agentRole } : {}),
    taskId: experience.taskId,
    runId: experience.runId,
    agentId: experience.agentId,
    canReadGlobal: false,
    canReadTaskHistory
  };
}

function buildInjectionUseReport(input: {
  readonly event: MemoryInjectionEvent;
  readonly experience: ExperienceEnvelope;
  readonly useKind: MemoryUseKind;
  readonly usedMemoryIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly actor: MemoryActor;
  readonly createId: () => string;
  readonly now: () => string;
}): MemoryUseReport {
  if (input.usedMemoryIds.length > MAX_INJECTION_MEMORY_IDS) {
    throw new MemoryValidationError(
      "Injection-use report contains too many memory ids."
    );
  }
  if (input.evidence.length > MAX_EXPERIENCE_REFERENCE_COUNT) {
    throw new MemoryValidationError(
      "Too many injection-use evidence references."
    );
  }
  const evidence = sanitizeEvidence(input.evidence);
  const trajectoryReferences = evidence.filter(
    (reference) => reference.kind === "trajectory"
  );
  if (
    trajectoryReferences.some(
      (reference) => reference.uri !== input.experience.trajectory.uri
    )
  ) {
    throw new MemoryValidationError(
      "Injection-use evidence must reference the captured experience trajectory."
    );
  }
  if (
    input.useKind !== "unobservable" &&
    !trajectoryReferences.some(
      (reference) => reference.uri === input.experience.trajectory.uri
    )
  ) {
    throw new MemoryValidationError(
      "An assessed injection-use report requires the captured trajectory as evidence."
    );
  }
  const report: MemoryUseReport = {
    id: input.createId(),
    injectionEventId: input.event.id,
    workspaceId: input.event.workspaceId,
    repositoryId: input.experience.repositoryId!,
    scope: input.event.scope,
    taskId: input.event.taskId,
    runId: input.event.runId,
    agentId: input.event.agentId,
    ...(input.event.agentRole ? { agentRole: input.event.agentRole } : {}),
    correlationToken: input.event.correlationToken,
    useKind: input.useKind,
    usedMemoryIds: [...input.usedMemoryIds],
    reportedAt: input.now(),
    reporterId: input.actor.id,
    reporterAuthority: input.actor.authority,
    reasonCode:
      input.useKind === "unobservable"
        ? "reporter_unobservable"
        : "reporter_supplied",
    evidence
  };
  try {
    assertMemoryUseReportInvariants(report, input.event);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new MemoryValidationError(error.message);
    }
    throw error;
  }
  return report;
}

export class MemoryAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryAuthorizationError";
  }
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

/**
 * Resolve one stored experience the caller is allowed to see.
 *
 * `MemoryService` is a single class covering capture, injection bookkeeping,
 * reporter assessments, cohorts, retrieval, research, verification and
 * curation. Control API handlers were typed against all of it while using one
 * to six members, which meant each handler declared a dependency on the whole
 * surface and tests could only stand in for it with an `as unknown as` cast.
 * These interfaces name the slices those handlers actually need; `MemoryService`
 * implements all of them.
 */
export interface MemoryExperienceReader {
  getExperience(
    id: string,
    context: MemoryReadContext
  ): Promise<ExperienceEnvelope | null>;
}

/** List the experiences a caller is allowed to see. */
export interface MemoryExperienceLister extends MemoryExperienceReader {
  listExperiences(
    request: ExperienceListRequest
  ): Promise<MemoryPage<ExperienceEnvelope>>;
}

/**
 * Read the reporter-supplied assessments recorded against experiences: the
 * joins an experience accumulated and the session-level report a reporter can
 * fetch directly. Read-only -- recording an assessment is a separate role.
 */
export interface MemoryAssessmentReader extends MemoryExperienceReader {
  listInjectionOutcomeJoins(
    request: MemoryInjectionOutcomeJoinRequest
  ): Promise<MemoryInjectionOutcomeJoinPage>;
  listInjectionUseJoins(
    request: MemoryInjectionUseJoinRequest
  ): Promise<MemoryInjectionUseJoinPage>;
  getSessionOutcomeReport(
    workspaceId: string,
    repositoryId: string,
    taskId: string,
    context: MemoryReadContext
  ): Promise<MemorySessionOutcomeReport | null>;
}

/** Record a reporter-supplied outcome, use assessment, or session report. */
export interface MemoryAssessmentRecorder extends MemoryExperienceReader {
  recordOutcomeReport(
    input: MemoryRecordOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }>;
  recordInjectionUseReport(input: {
    readonly experienceId: string;
    readonly injectionEventId: string;
    readonly useKind: MemoryUseKind;
    readonly usedMemoryIds: readonly string[];
    readonly evidence: readonly EvidenceReference[];
    readonly actor: MemoryActor;
    readonly context: MemoryReadContext;
  }): Promise<{ readonly appended: boolean; readonly id: string }>;
  recordSessionOutcomeReport(
    input: MemoryRecordSessionOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }>;
}

/**
 * Aggregate recorded assessments into cohorts. Purely derived reads: it needs
 * no experience lookup, which is what keeps it separate from the reader role.
 */
export interface MemoryAssessmentCohortReader {
  aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ): Promise<MemoryInjectionOutcomeCohortPage>;
  aggregateSessionOutcomeCohorts(
    request: MemorySessionOutcomeCohortFilter
  ): Promise<MemorySessionOutcomeCohortPage>;
  aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage>;
}

/** Withdraw one experience. Separate from listing because it is the only
 * handler that may destroy evidence, and it should stay narrow. */
export interface MemoryExperiencePurger {
  purgeExperience(
    experienceId: string,
    reason: MemoryExperiencePurgeReason,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<MemoryExperiencePurgeResult>;
}

export class MemoryService
  implements
    MemoryExperienceLister,
    MemoryAssessmentReader,
    MemoryAssessmentRecorder,
    MemoryAssessmentCohortReader,
    MemoryExperiencePurger
{
  private readonly repository: MemoryRepository;
  private readonly verifier: MemoryCurrentStateVerifier;
  private readonly reconstructor: MemoryReconstructor;
  private readonly tracer: Tracer;
  private readonly metrics: MemoryMetricInstruments;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly countTokens: ((text: string) => number) | undefined;
  private readonly embedder: MemoryEmbeddingProvider | undefined;
  private readonly maxResearchCandidates: number;
  private readonly skillPromotionWriter: MemorySkillPromotionWriter | undefined;

  constructor(options: MemoryServiceOptions) {
    this.repository = options.repository;
    this.verifier = options.verifier;
    this.reconstructor = options.reconstructor;
    this.tracer = options.tracer ?? trace.getTracer("autodev.memory");
    this.metrics = createMemoryMetricInstruments(
      options.meter ?? metrics.getMeter("autodev.memory", "1.0.0")
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.countTokens = options.countTokens;
    this.embedder = options.embedder;
    this.skillPromotionWriter = options.skillPromotionWriter;
    this.maxResearchCandidates =
      options.maxResearchCandidates ?? MAX_RESEARCH_CANDIDATES;
    if (
      !Number.isInteger(this.maxResearchCandidates) ||
      this.maxResearchCandidates < 1 ||
      this.maxResearchCandidates > MAX_RESEARCH_CANDIDATES
    ) {
      throw new TypeError(
        "Maximum memory reconstruction candidates must be between 1 and 40."
      );
    }
  }

  async captureExperience(
    input: MemoryExperienceCaptureInput,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<NormalizedTrajectorySummary> {
    const normalized = normalizeNativeTrajectory({
      source: input.source,
      transcript: input.transcript,
      uri: input.trajectoryUri
    });
    if (
      !Object.entries(normalized.roleCounts).some(
        ([role, count]) => role !== "meta" && count !== undefined && count > 0
      )
    ) {
      throw new MemoryValidationError(
        "Native trajectory contains no conversation records."
      );
    }
    const startedAt =
      input.experience.startedAt ??
      (normalized.timestampsInferred ? undefined : normalized.firstTimestamp) ??
      this.now();
    const completedAt =
      input.experience.completedAt ??
      (normalized.timestampsInferred ||
      !normalized.lastTimestamp ||
      Date.parse(normalized.lastTimestamp) < Date.parse(startedAt)
        ? undefined
        : normalized.lastTimestamp);
    await this.appendExperience(
      {
        ...input.experience,
        startedAt,
        ...(completedAt === undefined ? {} : { completedAt }),
        trajectory: {
          format: normalized.format,
          uri: normalized.uri,
          digest: normalized.digest,
          recordCount: normalized.recordCount,
          sourceAdapter: normalized.source,
          normalizerId: normalized.normalizerId,
          normalizerVersion: normalized.normalizerVersion,
          diagnosticCodes: normalized.diagnosticCodes
        }
      },
      actor,
      context
    );
    return normalized;
  }

  appendExperience(
    experience: ExperienceEnvelope,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<void> {
    return this.withSpan(MEMORY_OPERATIONS.experienceAppend, async (span) => {
      this.assertExperienceScope(experience);
      if (
        !isMemoryScopeVisibleTo(experience.scope, context) ||
        experience.workspaceId !== context.workspaceId ||
        (experience.repositoryId !== undefined &&
          experience.repositoryId !== context.repositoryId) ||
        (actor.authority === "worker" &&
          (actor.id !== experience.agentId ||
            experience.taskId !== context.taskId ||
            experience.runId !== context.runId))
      ) {
        throw new MemoryAuthorizationError(
          "Execution evidence is restricted to its authorized workspace, task, run, and agent."
        );
      }
      if (experience.evidence.length > MAX_EXPERIENCE_REFERENCE_COUNT) {
        throw new MemoryValidationError(
          "Too many experience evidence references."
        );
      }
      if (
        (experience.validation?.evidence.length ?? 0) >
        MAX_EXPERIENCE_REFERENCE_COUNT
      ) {
        throw new MemoryValidationError(
          "Too many experience validation references."
        );
      }
      span.setAttribute("memory.experience.outcome", experience.outcome);
      try {
        await this.repository.appendExperience({
          ...experience,
          trajectory: {
            ...experience.trajectory,
            uri: sanitizeEvidence([
              { kind: "trajectory", uri: experience.trajectory.uri }
            ])[0]!.uri
          },
          evidence: sanitizeEvidence(experience.evidence),
          ...(experience.validation
            ? {
                validation: {
                  ...experience.validation,
                  evidence: sanitizeEvidence(experience.validation.evidence)
                }
              }
            : {}),
          ...(experience.taskReference
            ? {
                taskReference: sanitizeEvidence([experience.taskReference])[0]!
              }
            : {}),
          ...(experience.planReference
            ? {
                planReference: sanitizeEvidence([experience.planReference])[0]!
              }
            : {})
        });
      } catch (error) {
        // Translate the repository-owned conflict at the Runtime boundary so
        // callers observe the MemoryService error contract consistently.
        if (error instanceof RepositoryMemoryConflictError) {
          throw new MemoryConflictError(error.message);
        }
        throw error;
      }
    });
  }

  /**
   * Append-only, idempotent record of an actual memory packet injection (or
   * empty/skipped research result) at the runtime boundary. The
   * `correlationToken` is opaque, content-free, and excluded from metric
   * dimensions; it exists solely so a later reporter-supplied outcome can be
   * joined back to the exact captured task/session scope without rewriting
   * any raw `ExperienceEnvelope` row. Re-emitting the same token returns
   * `{ appended: false, id: <existing> }` so the runtime treats retries as
   * already-recorded rather than overwriting prior observations.
   */
  recordInjectionEvent(
    input: MemoryRecordInjectionEventInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    return this.withSpan(MEMORY_OPERATIONS.injectionRecord, async (span) => {
      const { event } = input;
      this.assertActor(input.actor);
      if (
        !isMemoryScopeVisibleTo(event.scope, input.context) ||
        event.workspaceId !== input.context.workspaceId ||
        (event.repositoryId !== undefined &&
          event.repositoryId !== input.context.repositoryId) ||
        event.taskId !== input.context.taskId ||
        event.runId !== input.context.runId ||
        event.agentId !== input.context.agentId
      ) {
        throw new MemoryAuthorizationError(
          "Injection events are restricted to the trusted session's workspace, task, run, and agent."
        );
      }
      if (
        !event.correlationToken.trim() ||
        event.correlationToken.length > 256
      ) {
        throw new MemoryValidationError(
          "Injection event correlationToken is required and bounded."
        );
      }
      if (event.memoryIds.length > MAX_INJECTION_MEMORY_IDS) {
        throw new MemoryValidationError(
          "Injection event references too many memory ids."
        );
      }
      if (
        event.memoryIds.some(
          (memoryId) =>
            !memoryId.trim() || memoryId.length > MAX_INJECTION_REVISION_LENGTH
        )
      ) {
        throw new MemoryValidationError(
          "Injection event memory ids are invalid."
        );
      }
      if (
        !Number.isInteger(event.packetCharacterCount) ||
        event.packetCharacterCount < 0 ||
        event.packetCharacterCount > 24_000
      ) {
        throw new MemoryValidationError(
          "Injection event packet character count is invalid."
        );
      }
      if (
        event.packetTokenCount !== undefined &&
        (!Number.isInteger(event.packetTokenCount) ||
          event.packetTokenCount < 0 ||
          event.packetTokenCount > 8000)
      ) {
        throw new MemoryValidationError(
          "Injection event packet token count is invalid."
        );
      }
      for (const reference of event.evidence) {
        if (
          !reference.uri ||
          reference.uri.length > MAX_INJECTION_URI_LENGTH ||
          (reference.revision !== undefined &&
            reference.revision.length > MAX_INJECTION_REVISION_LENGTH)
        ) {
          throw new MemoryValidationError(
            "Injection event evidence reference is invalid."
          );
        }
      }
      try {
        const result = await this.repository.recordInjectionEvent({
          ...input,
          event: {
            ...event,
            evidence: sanitizeEvidence(event.evidence)
          }
        });
        span.setAttribute("memory.injection.appended", result.appended);
        span.setAttribute("memory.injection.result", event.injectionResult);
        span.setAttribute("memory.injection.mode", event.memoryMode);
        return result;
      } catch (error) {
        if (error instanceof RepositoryMemoryConflictError) {
          throw new MemoryConflictError(error.message);
        }
        throw error;
      }
    });
  }

  /**
   * Append-only, reporter-supplied outcome attached to an observed injection
   * event. Only operator/root/curator/system authorities may record outcomes;
   * non-`unknown` outcomes require at least one bounded evidence reference;
   * the report's `correlationToken` must resolve to a previously persisted
   * injection event in the exact (workspace, repository, task, run, agent)
   * scope, or the write fails closed. Duplicate reports return
   * `{ appended: false }` so retries remain safe.
   */
  recordOutcomeReport(
    input: MemoryRecordOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    return this.withSpan(MEMORY_OPERATIONS.outcomeReport, async (span) => {
      const { report } = input;
      this.assertActor(input.actor);
      // The recorded `reporter_authority` is always sourced from the trusted
      // MemoryActor. The Control API path maps an authenticated operator to
      // `root`, and the runtime emits only injection events under `system`,
      // so caller-supplied `report.reporterAuthority` is ignored.
      if (
        input.actor.authority !== "root" &&
        input.actor.authority !== "curator"
      ) {
        throw new MemoryAuthorizationError(
          "Only root or memory curator authorities may record outcome reports."
        );
      }
      const storedAuthority: MemoryAuthority = input.actor.authority;
      // Reporter context enforces workspace+repository+task identity (the
      // trusted session scope); the report's `runId`/`agentId` are session-
      // level and need not equal the request-level identifiers stored on
      // the underlying injection event. This is the explicit session-level
      // join documented in docs/memory-injection-outcome-evaluation.md.
      if (
        !isMemoryScopeVisibleTo(report.scope, input.context) ||
        report.workspaceId !== input.context.workspaceId ||
        (report.repositoryId !== undefined &&
          report.repositoryId !== input.context.repositoryId) ||
        report.taskId !== input.context.taskId
      ) {
        throw new MemoryAuthorizationError(
          "Outcome reports are restricted to the trusted session's workspace, repository, and task."
        );
      }
      if (!report.correlationToken.trim()) {
        throw new MemoryValidationError(
          "Outcome report correlationToken is required."
        );
      }
      const cleanEvidence = sanitizeEvidence(report.evidence);
      if (report.outcomeKind !== "unknown" && cleanEvidence.length === 0) {
        throw new MemoryValidationError(
          "Non-unknown outcome reports require at least one evidence reference."
        );
      }
      // Session-level lookup: the correlationToken must match an event whose
      // (workspace_id, repository_id, task_id) tuple matches the reporter's
      // trusted session scope. Request-level runId/agentId on the event row
      // are not part of the join.
      const injection =
        await this.repository.findInjectionEventByTokenForSession(
          {
            workspaceId: input.context.workspaceId,
            ...(input.context.repositoryId
              ? { repositoryId: input.context.repositoryId }
              : {}),
            taskId: input.context.taskId,
            ...(input.context.runId === undefined
              ? {}
              : { runId: input.context.runId }),
            ...(input.context.agentId === undefined
              ? {}
              : { agentId: input.context.agentId }),
            canReadGlobal: false
          },
          report.correlationToken
        );
      if (!injection) {
        throw new MemoryValidationError(
          "Outcome report targets a correlationToken that has no scope-aligned injection event."
        );
      }
      try {
        const result = await this.repository.recordOutcomeReport({
          ...input,
          report: {
            ...report,
            reporterAuthority: storedAuthority,
            evidence: cleanEvidence
          }
        });
        // Bounded outcome-cohort counter: the matched injection event is the
        // single evidence source for mode + actual injection result; the
        // report contributes only outcome kind + report kind. Any value not
        // in the bounded enum collapses to "unknown" so cardinality stays
        // bounded. Never export correlationToken, experience/task/run/agent
        // IDs, evidence URIs, claims, target bodies, or reporter IDs.
        const outcomeAttributes = recordOutcomeReportCohortAttributes(
          injection,
          report
        );
        span.setAttribute(
          "memory.outcome.report_kind",
          outcomeAttributes["autodev.memory.outcome.report_kind"]
        );
        span.setAttribute(
          "memory.outcome.kind",
          outcomeAttributes["autodev.memory.outcome.kind"]
        );
        span.setAttribute(
          "memory.outcome.injection_result",
          outcomeAttributes["autodev.memory.outcome.injection_result"]
        );
        span.setAttribute(
          "memory.outcome.memory_mode",
          outcomeAttributes["autodev.memory.outcome.memory_mode"]
        );
        if (result.appended) {
          recordMemoryMetric(() =>
            this.metrics.outcomeReports.add(1, outcomeAttributes)
          );
        }
        return result;
      } catch (error) {
        if (error instanceof RepositoryMemoryConflictError) {
          throw new MemoryConflictError(error.message);
        }
        throw error;
      }
    });
  }

  /**
   * Appends one curator-assessed use report for a concrete injected packet.
   * This is independent of task success and is never inferred from provider
   * output or a task/PR/issue outcome. The caller supplies only an event id;
   * Runtime resolves the opaque correlation token from the authorized event.
   */
  recordInjectionUseReport(input: {
    readonly experienceId: string;
    readonly injectionEventId: string;
    readonly useKind: MemoryUseKind;
    readonly usedMemoryIds: readonly string[];
    readonly evidence: readonly EvidenceReference[];
    readonly actor: MemoryActor;
    readonly context: MemoryReadContext;
  }): Promise<{ readonly appended: boolean; readonly id: string }> {
    return this.withSpan(MEMORY_OPERATIONS.useReport, async (span) => {
      this.assertActor(input.actor);
      assertInjectionUseReportAccess(input.actor, input.context);
      if (!isMemoryUseKind(input.useKind)) {
        throw new MemoryValidationError(
          "Injection-use report useKind is invalid."
        );
      }
      const experience = await this.getExperience(
        input.experienceId,
        input.context
      );
      if (!experience || !experience.repositoryId) {
        throw new MemoryValidationError(
          "Injection-use report requires a visible repository-scoped experience."
        );
      }
      if (
        input.context.workspaceId !== experience.workspaceId ||
        input.context.repositoryId !== experience.repositoryId
      ) {
        throw new MemoryAuthorizationError(
          "Injection-use report is restricted to the visible experience's workspace and repository."
        );
      }
      const reportContext = contextForCapturedExperience(
        experience,
        input.context.canReadTaskHistory === true
      );
      const event = await this.repository.getInjectionEventByIdForSession(
        {
          workspaceId: experience.workspaceId,
          repositoryId: experience.repositoryId,
          taskId: experience.taskId,
          runId: experience.runId,
          agentId: experience.agentId,
          canReadGlobal: false
        },
        input.injectionEventId
      );
      if (!event) {
        throw new MemoryValidationError(
          "Injection-use report targets an event outside the captured session."
        );
      }
      const report = buildInjectionUseReport({
        event,
        experience,
        useKind: input.useKind,
        usedMemoryIds: input.usedMemoryIds,
        evidence: input.evidence,
        actor: input.actor,
        createId: this.createId,
        now: this.now
      });
      try {
        const result = await this.repository.recordInjectionUseReport({
          report,
          actor: input.actor,
          context: reportContext
        });
        const attributes = {
          "autodev.memory.use.kind": report.useKind,
          "autodev.memory.use.memory_mode": event.memoryMode
        };
        span.setAttribute("memory.use.kind", report.useKind);
        span.setAttribute("memory.use.memory_mode", event.memoryMode);
        if (result.appended) {
          recordMemoryMetric(() => this.metrics.useReports.add(1, attributes));
        }
        return result;
      } catch (error) {
        if (error instanceof RepositoryMemoryConflictError) {
          throw new MemoryConflictError(error.message);
        }
        throw error;
      }
    });
  }

  /** Scoped join of injected packets with their curator-assessed use reports. */
  listInjectionUseJoins(
    request: MemoryInjectionUseJoinRequest
  ): Promise<MemoryInjectionUseJoinPage> {
    return this.withSpan(MEMORY_OPERATIONS.injectionUseList, async (span) => {
      if (request.context.canReadTaskHistory !== true) {
        throw new MemoryAuthorizationError(
          "Task-history access is required to read injection-use assessments."
        );
      }
      if (request.memoryModes?.some((mode) => !isMemoryExecutionMode(mode))) {
        throw new MemoryValidationError(
          "Injection-use join memory mode filter is invalid."
        );
      }
      if (
        request.injectionResults?.some(
          (value) =>
            value !== "injected" && value !== "empty" && value !== "skipped"
        )
      ) {
        throw new MemoryValidationError(
          "Injection-use join injection-result filter is invalid."
        );
      }
      if (request.useKinds?.some((kind) => !isMemoryUseKind(kind))) {
        throw new MemoryValidationError(
          "Injection-use join useKind filter is invalid."
        );
      }
      const sessionContext: MemoryReadContext = {
        workspaceId: request.context.workspaceId,
        ...(request.context.repositoryId
          ? { repositoryId: request.context.repositoryId }
          : {}),
        ...(request.context.role ? { role: request.context.role } : {}),
        ...(request.context.taskId ? { taskId: request.context.taskId } : {}),
        canReadGlobal: request.context.canReadGlobal,
        ...(request.context.canReadTaskHistory === undefined
          ? {}
          : { canReadTaskHistory: request.context.canReadTaskHistory })
      };
      const page = await this.repository.listInjectionUseJoins({
        ...request,
        context: sessionContext
      });
      const visible = page.items.filter(
        (join) =>
          isInjectionOutcomeVisibleToSession(join.injection, request.context) &&
          (join.use === null ||
            isInjectionOutcomeVisibleToSession(join.use, request.context))
      );
      span.setAttribute("memory.injection.use.total", visible.length);
      span.setAttribute(
        "memory.injection.use.include_unassessed",
        request.includeUnassessed === true
      );
      return { ...page, items: visible };
    });
  }

  /** Bounded, operator/task-history-gated aggregate over injected packets. */
  aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage> {
    return this.withSpan(
      MEMORY_OPERATIONS.injectionUseAggregate,
      async (span) => {
        if (request.context.canReadTaskHistory !== true) {
          throw new MemoryAuthorizationError(
            "Task-history access is required for injection-use cohorts."
          );
        }
        assertMemoryInjectionUseCohortFilter(request);
        const page =
          await this.repository.aggregateInjectionUseCohorts(request);
        const assessedCount = page.cells.reduce(
          (total, cell) =>
            total + (cell.useKind === null ? 0 : cell.exposureCount),
          0
        );
        span.setAttribute("memory.injection.use.exposures", page.exposureCount);
        span.setAttribute("memory.injection.use.assessed", assessedCount);
        span.setAttribute(
          "memory.injection.use.cohort_cells",
          page.cells.length
        );
        return page;
      }
    );
  }

  /**
   * Appends one reporter-supplied session-level outcome report.
   * Exactly one report is permitted per unique session key (workspace_id, repository_id, task_id).
   * Scope-aligned injection event must exist.
   * Same-body retries return appended: false; conflicting retries fail closed.
   */
  recordSessionOutcomeReport(
    input: MemoryRecordSessionOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    return this.withSpan(
      MEMORY_OPERATIONS.sessionOutcomeReport,
      async (span) => {
        const { report } = input;
        this.assertActor(input.actor);
        if (
          input.actor.authority !== "root" &&
          input.actor.authority !== "curator"
        ) {
          throw new MemoryAuthorizationError(
            "Only root or memory curator authorities may record session outcome reports."
          );
        }
        const storedAuthority: MemoryAuthority = input.actor.authority;
        if (
          report.workspaceId !== input.context.workspaceId ||
          !input.context.repositoryId ||
          report.repositoryId !== input.context.repositoryId ||
          report.taskId !== input.context.taskId
        ) {
          throw new MemoryAuthorizationError(
            "Session outcome reports are restricted to the trusted session's workspace, repository, and task."
          );
        }
        const cleanEvidence = sanitizeEvidence(report.evidence);
        if (report.outcomeKind !== "unknown" && cleanEvidence.length === 0) {
          throw new MemoryValidationError(
            "Non-unknown outcome reports require at least one evidence reference."
          );
        }
        try {
          const result = await this.repository.recordSessionOutcomeReport({
            ...input,
            report: {
              ...report,
              reporterAuthority: storedAuthority,
              evidence: cleanEvidence
            }
          });
          const reportKindValue: string = isMemoryOutcomeReportKind(
            report.reportKind
          )
            ? report.reportKind
            : "unknown";
          const outcomeKindValue: string = EXPERIENCE_OUTCOMES.includes(
            report.outcomeKind as (typeof EXPERIENCE_OUTCOMES)[number]
          )
            ? report.outcomeKind
            : "unknown";
          span.setAttribute(
            "memory.session.outcome.report_kind",
            reportKindValue
          );
          span.setAttribute("memory.session.outcome.kind", outcomeKindValue);
          if (result.appended) {
            recordMemoryMetric(() =>
              this.metrics.sessionOutcomeReports.add(1, {
                "autodev.memory.session_outcome.report_kind": reportKindValue,
                "autodev.memory.session_outcome.kind": outcomeKindValue
              })
            );
          }
          return result;
        } catch (error) {
          if (error instanceof RepositoryMemoryConflictError) {
            throw new MemoryConflictError(error.message);
          }
          throw error;
        }
      }
    );
  }

  /**
   * Look up the single session outcome report for a trusted session key, if any.
   */
  getSessionOutcomeReport(
    workspaceId: string,
    repositoryId: string,
    taskId: string,
    context: MemoryReadContext
  ): Promise<MemorySessionOutcomeReport | null> {
    if (context.workspaceId !== workspaceId) {
      throw new MemoryAuthorizationError(
        "Workspace mismatch in session outcome report retrieval."
      );
    }
    if (
      context.repositoryId !== undefined &&
      context.repositoryId !== repositoryId
    ) {
      throw new MemoryAuthorizationError(
        "Repository mismatch in session outcome report retrieval."
      );
    }
    if (!context.canReadTaskHistory && context.taskId !== taskId) {
      throw new MemoryAuthorizationError(
        "Task history access required to read another session's outcome report."
      );
    }
    return this.repository.getSessionOutcomeReport(
      workspaceId,
      repositoryId,
      taskId
    );
  }

  /**
   * Scoped read/join between stored injection events and their
   * reporter-supplied outcomes. Returns one row per injection; rows without a
   * matching outcome carry `outcome: null`. Reports that point at an injection
   * event outside the authorized scope never appear here because the report
   * write was rejected at the MemoryService boundary.
   */
  listInjectionOutcomeJoins(
    request: MemoryInjectionOutcomeJoinRequest
  ): Promise<MemoryInjectionOutcomeJoinPage> {
    return this.withSpan(
      MEMORY_OPERATIONS.injectionOutcomeList,
      async (span) => {
        if (
          request.memoryModes !== undefined &&
          request.memoryModes.length > MEMORY_EXECUTION_MODES.length
        ) {
          throw new MemoryValidationError(
            "Injection/outcome join memory mode filter is invalid."
          );
        }
        if (
          request.injectionResults !== undefined &&
          request.injectionResults.some(
            (value) =>
              value !== "injected" && value !== "empty" && value !== "skipped"
          )
        ) {
          throw new MemoryValidationError(
            "Injection/outcome join injection result filter is invalid."
          );
        }
        if (
          request.reportKinds !== undefined &&
          request.reportKinds.some(
            (kind) => !MEMORY_OUTCOME_REPORT_KINDS.includes(kind as never)
          )
        ) {
          throw new MemoryValidationError(
            "Injection/outcome join report kind filter is invalid."
          );
        }
        // Session/task-scoped visibility: the reporter context carries the
        // session-level task id (Codex capture uses taskId=runId=agentId=
        // sessionId). The injection event row, however, retains request-level
        // runId/agentId that the join must NOT compare against. We pass
        // only the trusted session identity forward.
        const sessionContext: MemoryReadContext = {
          workspaceId: request.context.workspaceId,
          ...(request.context.repositoryId
            ? { repositoryId: request.context.repositoryId }
            : {}),
          ...(request.context.role ? { role: request.context.role } : {}),
          ...(request.context.taskId ? { taskId: request.context.taskId } : {}),
          canReadGlobal: request.context.canReadGlobal,
          ...(request.context.canReadTaskHistory === undefined
            ? {}
            : { canReadTaskHistory: request.context.canReadTaskHistory })
        };
        const page = await this.repository.listInjectionOutcomeJoins({
          ...request,
          context: sessionContext
        });
        const visible = page.items.filter(
          (join) =>
            isInjectionOutcomeVisibleToSession(
              join.injection,
              request.context
            ) &&
            (join.outcome === null ||
              isInjectionOutcomeVisibleToSession(join.outcome, request.context))
        );
        span.setAttribute("memory.injection.outcome.total", visible.length);
        span.setAttribute(
          "memory.injection.outcome.include_unreported",
          request.includeUnreported === true
        );
        return { ...page, items: visible };
      }
    );
  }

  /**
   * Bounded workspace/repository/time aggregate over the canonical append-only
   * injection/outcome events. The repository returns counts only; no
   * session-level identifiers or evidence leave the persistence boundary.
   */
  aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ): Promise<MemoryInjectionOutcomeCohortPage> {
    return this.withSpan(
      MEMORY_OPERATIONS.injectionOutcomeAggregate,
      async (span) => {
        if (request.context.canReadTaskHistory !== true) {
          throw new MemoryAuthorizationError(
            "Task-history access is required for memory outcome cohorts."
          );
        }
        assertMemoryInjectionOutcomeCohortFilter(request);
        const page =
          await this.repository.aggregateInjectionOutcomeCohorts(request);
        span.setAttribute(
          "memory.injection.outcome.exposures",
          page.exposureCount
        );
        span.setAttribute("memory.injection.outcome.reports", page.reportCount);
        span.setAttribute(
          "memory.injection.outcome.cohort_cells",
          page.cells.length
        );
        return page;
      }
    );
  }

  /**
   * Bounded workspace/repository/time aggregate over deduplicated sessions.
   * Derives session mode and consensus outcome across the full injection set.
   * Returns counts only; no IDs, tokens, or evidence.
   */
  aggregateSessionOutcomeCohorts(
    request: MemorySessionOutcomeCohortFilter
  ): Promise<MemorySessionOutcomeCohortPage> {
    return this.withSpan(
      MEMORY_OPERATIONS.sessionOutcomeAggregate,
      async (span) => {
        if (request.context.canReadTaskHistory !== true) {
          throw new MemoryAuthorizationError(
            "Task-history access is required for memory session outcome cohorts."
          );
        }
        assertMemorySessionOutcomeCohortFilter(request);
        const page =
          await this.repository.aggregateSessionOutcomeCohorts(request);
        span.setAttribute("memory.session.outcome.sessions", page.sessionCount);
        span.setAttribute(
          "memory.session.outcome.reported_sessions",
          page.reportedSessionCount
        );
        span.setAttribute(
          "memory.session.outcome.unreported_sessions",
          page.unreportedSessionCount
        );
        span.setAttribute(
          "memory.session.outcome.conflicting_sessions",
          page.conflictingOutcomeSessionCount
        );
        span.setAttribute(
          "memory.session.outcome.mixed_mode_sessions",
          page.mixedModeSessionCount
        );
        span.setAttribute(
          "memory.session.outcome.cohort_cells",
          page.cells.length
        );
        return page;
      }
    );
  }

  propose(
    input: MemoryProposalInput,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<MemoryRecord> {
    return this.withSpan(MEMORY_OPERATIONS.propose, async (span) => {
      const candidate = await this.createCandidate(
        input,
        actor,
        context,
        "proposed",
        []
      );
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.kind, input.kind);
      return candidate;
    });
  }

  revise(
    id: string,
    input: Omit<MemoryProposalInput, "kind" | "scope">,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<MemoryRecord> {
    return this.withSpan(MEMORY_OPERATIONS.revise, async (span) => {
      const original = await this.get(id, context);
      if (
        !original ||
        (original.status !== "active" && original.status !== "uncertain")
      )
        throw new MemoryValidationError(
          "Only a visible active or uncertain memory can be revised."
        );
      const candidate = await this.createCandidate(
        { ...input, kind: original.kind, scope: original.scope },
        actor,
        context,
        "revised",
        [original.id]
      );
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.kind, original.kind);
      return candidate;
    });
  }

  private async createCandidate(
    input: MemoryProposalInput,
    actor: MemoryActor,
    context: MemoryReadContext,
    action: "proposed" | "revised",
    relatedMemoryIds: readonly string[]
  ): Promise<MemoryRecord> {
    this.assertActor(actor);
    if (
      actor.authority === "worker" &&
      (input.scope.kind === "global" ||
        !isMemoryScopeVisibleTo(input.scope, context))
    ) {
      throw new MemoryAuthorizationError(
        "Workers may propose only memory scoped to their authorized workspace, repository, role, or task."
      );
    }
    const claim = redactSensitiveText(input.claim.trim());
    if (!claim || claim.length > MAX_CLAIM_LENGTH)
      throw new MemoryValidationError(
        "A memory claim must be concise and non-empty."
      );
    if (
      input.experienceIds.length === 0 ||
      input.experienceIds.length > MAX_EXPERIENCE_REFERENCE_COUNT ||
      input.experienceIds.some(
        (experienceId) =>
          !experienceId.trim() ||
          experienceId.length > MAX_MEMORY_REFERENCE_ID_LENGTH
      )
    ) {
      throw new MemoryValidationError(
        "A durable memory requires a bounded set of source experiences."
      );
    }
    const experienceIds = [...new Set(input.experienceIds)];
    const experienceReadContext = context;
    const sourceExperiences = await Promise.all(
      experienceIds.map((experienceId) =>
        this.repository.getExperience(experienceId, experienceReadContext)
      )
    );
    if (
      sourceExperiences.some(
        (experience) =>
          !experience ||
          !isMemoryExperienceVisibleTo(experience, experienceReadContext) ||
          experience.workspaceId !== context.workspaceId
      )
    ) {
      throw new MemoryAuthorizationError(
        "Every source experience must be visible in the current workspace context."
      );
    }
    if (input.evidence.length === 0)
      throw new MemoryValidationError(
        "A durable memory requires evidence references."
      );
    const evidence = sanitizeEvidence(input.evidence);
    const createdAt = this.now();
    const candidate: MemoryRecord = {
      id: this.createId(),
      kind: input.kind,
      scope: input.scope,
      claim,
      status: "proposed",
      provenance: {
        experienceIds,
        evidence,
        createdBy: actor.id,
        createdAt
      },
      validity: { state: "unverified", evidence: [] },
      createdAt,
      updatedAt: createdAt
    };
    const event = this.event({
      memoryId: candidate.id,
      action,
      actor,
      toStatus: "proposed",
      reasonCode:
        action === "proposed" ? "candidate_submitted" : "revised_after_review",
      evidence,
      relatedMemoryIds
    });
    const embedding = await this.optionalEmbedding(claim);
    await this.repository.proposeMemory(candidate, event, embedding);
    return candidate;
  }

  async get(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryRecord | null> {
    const memory = await this.repository.getMemory(id, context);
    return memory && isMemoryScopeVisibleTo(memory.scope, context)
      ? memory
      : null;
  }

  async searchExperiences(
    request: ExperienceSearchRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    this.assertQuery(request.query);
    const experiences = await this.repository.searchExperiences({
      ...request,
      limit: Math.min(Math.max(request.limit ?? 10, 1), MAX_RESEARCH_HITS)
    });
    return experiences
      .filter((experience) =>
        isMemoryExperienceVisibleTo(experience, request.context)
      )
      .slice(0, Math.min(Math.max(request.limit ?? 10, 1), MAX_RESEARCH_HITS));
  }

  async listExperiences(
    request: ExperienceListRequest
  ): Promise<MemoryPage<ExperienceEnvelope>> {
    this.assertOptionalQuery(request.query);
    this.assertMemoryModes(request.memoryModes);
    this.assertExperienceOutcomes(request.outcomes);
    const pagination = this.pageRequest(request.limit, request.offset);
    const page = await this.repository.listExperiences({
      ...request,
      ...pagination
    });
    return {
      ...page,
      ...pagination,
      items: page.items.filter((experience) =>
        isMemoryExperienceVisibleTo(experience, request.context)
      )
    };
  }

  async getExperience(
    id: string,
    context: MemoryReadContext
  ): Promise<ExperienceEnvelope | null> {
    const experience = await this.repository.getExperience(id, context);
    return experience && isMemoryExperienceVisibleTo(experience, context)
      ? experience
      : null;
  }

  async history(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryHistory | null> {
    const history = await this.repository.getMemoryHistory(id, context);
    return history && isMemoryScopeVisibleTo(history.memory.scope, context)
      ? history
      : null;
  }

  async why(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryWhyResult | null> {
    const history = await this.history(id, context);
    if (!history) return null;
    const sourceExperiences = await Promise.all(
      history.memory.provenance.experienceIds.map((experienceId) =>
        this.getExperience(experienceId, context)
      )
    );
    return {
      ...history,
      sourceExperiences: sourceExperiences.filter(
        (experience): experience is ExperienceEnvelope => experience !== null
      )
    };
  }

  async listMemories(
    request: MemoryListRequest
  ): Promise<MemoryRecordPage> {
    this.assertOptionalQuery(request.query);
    const pagination = this.pageRequest(request.limit, request.offset);
    const page = await this.repository.listMemories({
      ...request,
      ...pagination
    });
    return {
      ...page,
      ...pagination,
      items: page.items.filter((memory) =>
        isMemoryScopeVisibleTo(memory.scope, request.context)
      )
    };
  }

  purgeExpiredExperiences(input: {
    readonly completedBefore: string;
    readonly limit: number;
    readonly actor: MemoryActor;
    readonly context: MemoryReadContext;
  }): Promise<MemoryExperienceRetentionReport> {
    return this.withSpan(
      MEMORY_OPERATIONS.experienceRetention,
      async (span) => {
        this.assertCurator(input.actor);
        if (
          !input.context.workspaceId.trim() ||
          !input.context.repositoryId?.trim()
        ) {
          throw new MemoryValidationError(
            "Memory retention requires an explicit workspace and repository."
          );
        }
        if (!input.context.canReadTaskHistory) {
          throw new MemoryAuthorizationError(
            "Memory retention requires curator access to workspace-bounded task history."
          );
        }
        const cutoff = Date.parse(input.completedBefore);
        const now = Date.parse(this.now());
        if (
          !Number.isFinite(cutoff) ||
          !Number.isFinite(now) ||
          cutoff > now ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > MAX_RETENTION_BATCH_SIZE
        ) {
          throw new MemoryValidationError(
            "Memory retention scan bounds are invalid."
          );
        }
        const candidates = await this.repository.listExpiredExperiences({
          completedBefore: new Date(cutoff).toISOString(),
          limit: input.limit,
          context: input.context
        } satisfies MemoryExpiredExperienceRequest);
        const batch = candidates.slice(0, input.limit);
        const visibleCandidates = batch.filter((experience) =>
          isMemoryExperienceVisibleTo(experience, input.context)
        );
        let purged = 0;
        let referencedByMemory = 0;
        let noLongerVisible = batch.length - visibleCandidates.length;
        // Keep retention sequential and batch-bounded; each erasure runs its own
        // transaction and rechecks provenance under a row lock.
        /* eslint-disable no-await-in-loop -- preserve bounded transactional purge order */
        for (const experience of visibleCandidates) {
          const result = await this.purgeExperience(
            experience.id,
            "retention_expired",
            input.actor,
            input.context
          );
          if (result === "purged") purged += 1;
          else if (result === "referenced_by_memory") referencedByMemory += 1;
          else noLongerVisible += 1;
        }
        /* eslint-enable no-await-in-loop */
        span.setAttribute(
          "memory.retention.selected",
          visibleCandidates.length
        );
        span.setAttribute("memory.retention.purged", purged);
        span.setAttribute("memory.retention.referenced", referencedByMemory);
        span.setAttribute("memory.retention.not_visible", noLongerVisible);
        return {
          selected: visibleCandidates.length,
          purged,
          referencedByMemory,
          noLongerVisible
        };
      }
    );
  }

  purgeExperience(
    experienceId: string,
    reason: MemoryExperiencePurgeReason,
    actor: MemoryActor,
    context: MemoryReadContext
  ): Promise<MemoryExperiencePurgeResult> {
    return this.withSpan(MEMORY_OPERATIONS.experiencePurge, async (span) => {
      this.assertCurator(actor);
      if (
        !experienceId.trim() ||
        experienceId.length > MAX_MEMORY_REFERENCE_ID_LENGTH
      ) {
        throw new MemoryValidationError("Memory experience id is invalid.");
      }
      if (!isMemoryExperiencePurgeReason(reason)) {
        throw new MemoryValidationError("Memory purge reason is invalid.");
      }
      span.setAttribute("memory.experience.purge.reason", reason);
      const result = await this.repository.purgeExperience({
        experienceId,
        context,
        eventId: this.createId(),
        actorId: actor.id,
        reason,
        occurredAt: this.now()
      });
      span.setAttribute("memory.experience.purge.outcome", result);
      return result;
    });
  }

  search(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]> {
    return this.withSpan(MEMORY_OPERATIONS.query, async (span) => {
      this.assertQuery(request.query);
      this.assertTaskKind(request.taskKind);
      const queryEmbedding = await this.optionalEmbedding(request.query);
      const asOf = request.asOf ?? this.now();
      const hits = await this.repository.searchMemories({
        ...request,
        asOf,
        ...(queryEmbedding ? { queryEmbedding } : {}),
        limit: Math.min(Math.max(request.limit ?? 10, 1), MAX_RESEARCH_HITS)
      });
      const eligibleHits = hits
        .filter((hit) => this.isEligibleRecord(hit.memory, asOf))
        .filter((hit) =>
          isMemoryScopeVisibleTo(hit.memory.scope, request.context)
        )
        .sort((left, right) => right.score - left.score)
        .slice(
          0,
          Math.min(Math.max(request.limit ?? 10, 1), MAX_RESEARCH_HITS)
        );
      span.setAttribute("memory.candidates.retrieved", eligibleHits.length);
      for (const hit of eligibleHits) {
        recordMemoryMetric(() =>
          this.metrics.candidates.add(1, {
            "autodev.memory.candidate.stage": "retrieved",
            "autodev.memory.kind": hit.memory.kind
          })
        );
      }
      return eligibleHits;
    });
  }

  invalidate(
    id: string,
    actor: MemoryActor,
    context: MemoryReadContext,
    evidence: readonly EvidenceReference[],
    reasonCode: MemoryReasonCode = "invalidated_by_curator"
  ): Promise<MemoryRecord> {
    return this.withSpan(MEMORY_OPERATIONS.invalidate, async (span) => {
      this.assertCurator(actor);
      const current = await this.get(id, context);
      if (!current)
        throw new MemoryValidationError("Memory record was not found.");
      if (current.status === "invalidated" || current.status === "superseded")
        throw new MemoryValidationError(
          "Only live memory records can be invalidated."
        );
      const updatedAt = this.now();
      const next: MemoryRecord = {
        ...current,
        status: "invalidated",
        updatedAt
      };
      const cleanEvidence = sanitizeEvidence(evidence);
      if (cleanEvidence.length === 0)
        throw new MemoryValidationError("Invalidation requires evidence.");
      const event = this.event({
        memoryId: id,
        action: "invalidated",
        actor,
        fromStatus: current.status,
        toStatus: "invalidated",
        reasonCode,
        evidence: cleanEvidence
      });
      await this.commit(
        [{ expectedUpdatedAt: current.updatedAt, next }],
        [event]
      );
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.kind, current.kind);
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.status, next.status);
      return next;
    });
  }

  promoteProcedureToSkill(
    id: string,
    input: MemorySkillPromotionInput,
    actor: MemoryActor,
    request: MemoryResearchRequest
  ): Promise<{ memory: MemoryRecord; skill: MemorySkillPromotionArtifact }> {
    return this.withSpan(MEMORY_OPERATIONS.promote, async (span) => {
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.kind, "procedural");
      span.setAttribute("memory.promotion.target", "rulesync_skill");
      const result = await this.promoteProcedureToSkillCore(
        id,
        input,
        actor,
        request
      );
      span.setAttribute("memory.promotion.outcome", "success");
      return result;
    });
  }

  private async promoteProcedureToSkillCore(
    id: string,
    input: MemorySkillPromotionInput,
    actor: MemoryActor,
    request: MemoryResearchRequest
  ): Promise<{ memory: MemoryRecord; skill: MemorySkillPromotionArtifact }> {
    this.assertCurator(actor);
    if (!this.skillPromotionWriter)
      throw new MemoryValidationError(
        "Canonical RuleSync skill promotion is not configured."
      );

    const current = await this.get(id, request.context);
    if (!current || current.kind !== "procedural")
      throw new MemoryValidationError(
        "Only a visible procedural memory can become a canonical skill."
      );
    const rawDescription = input.description.trim();
    const rawContent = input.content.trim();
    const description = redactSensitiveText(rawDescription);
    const content = redactSensitiveText(rawContent);
    if (description !== rawDescription || content !== rawContent)
      throw new MemoryValidationError(
        "Canonical skill content must not contain credential-like values."
      );
    if (
      !MEMORY_SKILL_NAME_PATTERN.test(input.name.trim()) ||
      input.name.trim().startsWith("-") ||
      input.name.trim().endsWith("-") ||
      input.name.trim().includes("--") ||
      !description ||
      description.length > MAX_SKILL_DESCRIPTION_LENGTH ||
      !content ||
      content.length > MAX_SKILL_CONTENT_LENGTH
    ) {
      throw new MemoryValidationError(
        "Skill name, description, or content exceeds its validation bound."
      );
    }

    const history = await this.history(id, request.context);
    const priorPromotion = history?.events.find(
      (event) =>
        event.action === "procedure_promoted" &&
        event.reasonCode === "promoted_to_skill"
    );
    if (priorPromotion) {
      const expectedUri = `rulesync://skills/${encodeURIComponent(input.name.trim())}/SKILL.md`;
      const previousSkill = priorPromotion.evidence.find(
        (evidence) => evidence.kind === "skill" && evidence.uri === expectedUri
      );
      if (!previousSkill)
        throw new MemoryConflictError(
          "This procedure was already promoted to a different canonical skill."
        );
      const skill = await this.skillPromotionWriter.createSkill({
        name: input.name,
        description,
        content,
        context: request.context
      });
      if (previousSkill.revision !== skill.revision)
        throw new MemoryConflictError(
          "The canonical skill differs from its recorded promotion revision."
        );
      return { memory: current, skill };
    }

    if (current.status !== "active" || current.validity.state !== "verified")
      throw new MemoryValidationError(
        "Only a current-state-verified procedural memory can be promoted."
      );
    if (current.provenance.experienceIds.length < MIN_VALIDATED_PROMOTION_RUNS)
      throw new MemoryValidationError(
        "Skill promotion requires at least two validated successful runs."
      );
    const why = await this.why(id, request.context);
    const verifiedRuns = new Set<string>();
    for (const experience of why?.sourceExperiences ?? []) {
      if (
        experience.outcome === "success" &&
        experience.validation?.state === "passed" &&
        experience.validation.evidence.length > 0
      ) {
        verifiedRuns.add(`${experience.taskId}\u0000${experience.runId}`);
      }
    }
    if (verifiedRuns.size < MIN_VALIDATED_PROMOTION_RUNS)
      throw new MemoryValidationError(
        "Skill promotion requires two distinct successful runs with passing validation evidence."
      );

    const assessment = await this.verify(current, request);
    if (
      assessment.compatibility !== "compatible" ||
      assessment.evidence.length === 0
    ) {
      throw new MemoryValidationError(
        "The procedure must be verified against current state immediately before promotion."
      );
    }
    const skill = await this.skillPromotionWriter.createSkill({
      name: input.name,
      description,
      content,
      context: request.context
    });
    const skillEvidence: EvidenceReference = {
      kind: "skill",
      uri: skill.uri,
      revision: skill.revision,
      observedAt: this.now()
    };
    const updatedAt = this.now();
    const verifiedEvidence = sanitizeEvidence(assessment.evidence);
    const next: MemoryRecord = {
      ...current,
      status: "invalidated",
      validity: {
        ...current.validity,
        state: "verified",
        checkedAt: assessment.checkedAt,
        verificationSource: assessment.source,
        evidence: mergeEvidence(current.validity.evidence, verifiedEvidence)
      },
      provenance: {
        ...current.provenance,
        lastVerifiedAt: assessment.checkedAt,
        verificationSource: assessment.source
      },
      updatedAt
    };
    const event = this.event({
      memoryId: current.id,
      action: "procedure_promoted",
      actor,
      fromStatus: current.status,
      toStatus: "invalidated",
      reasonCode: "promoted_to_skill",
      evidence: [...verifiedEvidence, ...sanitizeEvidence([skillEvidence])]
    });
    await this.commit(
      [{ expectedUpdatedAt: current.updatedAt, next }],
      [event]
    );
    return { memory: next, skill };
  }

  verifyAndPromote(
    id: string,
    actor: MemoryActor,
    request: MemoryResearchRequest
  ): Promise<MemoryRecord> {
    return this.withSpan(MEMORY_OPERATIONS.verify, async (span) => {
      this.assertCurator(actor);
      const current = await this.get(id, request.context);
      if (!current)
        throw new MemoryValidationError("Memory record was not found.");
      if (current.status !== "proposed")
        throw new MemoryValidationError(
          "Only proposed memories can be promoted."
        );

      const assessment = await this.verify(current, request);
      const updatedAt = this.now();
      const promotable =
        assessment.compatibility === "compatible" &&
        assessment.evidence.length > 0;
      const next: MemoryRecord = {
        ...current,
        status: promotable ? "active" : "uncertain",
        validity: {
          state: promotable
            ? "verified"
            : assessment.compatibility === "contradicted"
              ? "contradicted"
              : "uncertain",
          checkedAt: assessment.checkedAt,
          verificationSource: assessment.source,
          evidence: sanitizeEvidence(assessment.evidence)
        },
        provenance: {
          ...current.provenance,
          lastVerifiedAt: assessment.checkedAt,
          verificationSource: assessment.source
        },
        updatedAt
      };
      const event = this.event({
        memoryId: id,
        action: promotable ? "promoted" : "verified",
        actor,
        fromStatus: current.status,
        toStatus: next.status,
        reasonCode: promotable
          ? "verified_current_state"
          : assessment.reasonCode,
        evidence: sanitizeEvidence(assessment.evidence)
      });
      await this.commit(
        [{ expectedUpdatedAt: current.updatedAt, next }],
        [event]
      );
      span.setAttribute(
        MEMORY_SPAN_ATTRIBUTES.validation,
        assessment.compatibility
      );
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.status, next.status);
      return next;
    });
  }

  supersede(
    replacementId: string,
    priorId: string,
    actor: MemoryActor,
    request: MemoryResearchRequest
  ): Promise<MemoryRecord> {
    return this.withSpan(MEMORY_OPERATIONS.supersede, async (span) => {
      this.assertCurator(actor);
      const [replacement, prior] = await Promise.all([
        this.get(replacementId, request.context),
        this.get(priorId, request.context)
      ]);
      if (!replacement || !prior)
        throw new MemoryValidationError(
          "Both memory records must be visible to supersede."
        );
      if (replacement.status !== "proposed" || prior.status !== "active")
        throw new MemoryValidationError(
          "Supersession requires a proposal and an active prior record."
        );
      if (
        replacement.kind !== prior.kind ||
        scopeKey(replacement) !== scopeKey(prior)
      )
        throw new MemoryValidationError(
          "A memory can supersede only the same kind and exact scope."
        );

      const assessment = await this.verify(replacement, request);
      if (
        assessment.compatibility !== "compatible" ||
        assessment.evidence.length === 0
      )
        throw new MemoryValidationError(
          "Replacement must be verified against current authoritative state."
        );

      const updatedAt = this.now();
      const verifiedEvidence = sanitizeEvidence(assessment.evidence);
      const nextReplacement: MemoryRecord = {
        ...replacement,
        status: "active",
        supersedes: [...new Set([...(replacement.supersedes ?? []), prior.id])],
        validity: {
          state: "verified",
          checkedAt: assessment.checkedAt,
          verificationSource: assessment.source,
          evidence: verifiedEvidence
        },
        provenance: {
          ...replacement.provenance,
          lastVerifiedAt: assessment.checkedAt,
          verificationSource: assessment.source
        },
        updatedAt
      };
      const nextPrior: MemoryRecord = {
        ...prior,
        status: "superseded",
        supersededBy: [
          ...new Set([...(prior.supersededBy ?? []), replacement.id])
        ],
        updatedAt
      };
      const events = [
        this.event({
          memoryId: replacement.id,
          action: "promoted",
          actor,
          fromStatus: replacement.status,
          toStatus: "active",
          reasonCode: "verified_current_state",
          evidence: verifiedEvidence,
          relatedMemoryIds: [prior.id]
        }),
        this.event({
          memoryId: prior.id,
          action: "superseded",
          actor,
          fromStatus: prior.status,
          toStatus: "superseded",
          reasonCode: "superseded_by_newer_evidence",
          evidence: verifiedEvidence,
          relatedMemoryIds: [replacement.id]
        })
      ];
      await this.commit(
        [
          { expectedUpdatedAt: replacement.updatedAt, next: nextReplacement },
          { expectedUpdatedAt: prior.updatedAt, next: nextPrior }
        ],
        events
      );
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.kind, replacement.kind);
      span.setAttribute(MEMORY_SPAN_ATTRIBUTES.status, nextReplacement.status);
      return nextReplacement;
    });
  }

  research(request: MemoryResearchRequest): Promise<MemoryPacket> {
    return this.withSpan(MEMORY_OPERATIONS.research, async (rootSpan) => {
      this.assertQuery(request.query);
      this.assertTaskKind(request.taskKind);
      if (!request.task.trim())
        throw new MemoryValidationError("Research requires the current task.");
      if (
        !Number.isInteger(request.maxPacketCharacters) ||
        request.maxPacketCharacters < 0 ||
        request.maxPacketCharacters > MAX_PACKET_CHARACTERS
      ) {
        throw new MemoryValidationError(
          "Memory packet character bound is invalid."
        );
      }
      if (request.maxPacketTokens !== undefined && !this.countTokens)
        throw new MemoryValidationError(
          "A token counter is required for token-bounded packets."
        );

      const asOf = request.asOf ?? this.now();
      const queryRequest: MemorySearchRequest = {
        query: request.query,
        context: request.context,
        asOf,
        limit: this.maxResearchCandidates,
        ...(request.kinds ? { kinds: request.kinds } : {}),
        ...(request.relevantPaths
          ? { relevantPaths: request.relevantPaths }
          : {}),
        ...(request.taskKind ? { taskKind: request.taskKind } : {})
      };
      const hits = await this.retrieveMemories(queryRequest, request.query);
      const rejectionCounts = new Map<MemoryReasonCode, number>();
      for (const hit of hits) {
        recordMemoryMetric(() =>
          this.metrics.candidates.add(1, {
            "autodev.memory.candidate.stage": "retrieved",
            "autodev.memory.kind": hit.memory.kind
          })
        );
      }
      const ranked = await this.rerankMemories(
        hits,
        request.context,
        asOf,
        rejectionCounts
      );
      const entries = await this.reconstructMemories(
        ranked,
        request,
        rejectionCounts
      );
      const packet = await this.withSpan(MEMORY_OPERATIONS.packet, (span) => {
        const bounded = this.boundPacket(request, entries);
        span.setAttribute("memory.packet.characters", bounded.characterCount);
        span.setAttribute("memory.packet.entries", bounded.entries.length);
        span.setAttribute("memory.packet.omitted", bounded.omittedCount);
        if (bounded.tokenCount !== undefined)
          span.setAttribute("memory.packet.tokens", bounded.tokenCount);
        return bounded;
      });
      this.recordResearchResults(
        rootSpan,
        hits,
        entries,
        packet,
        rejectionCounts
      );
      return packet;
    });
  }

  private retrieveMemories(
    request: MemorySearchRequest,
    query: string
  ): Promise<readonly MemorySearchHit[]> {
    return this.withSpan(MEMORY_OPERATIONS.query, async () => {
      const queryEmbedding = await this.optionalEmbedding(query);
      return this.withSpan(MEMORY_OPERATIONS.retrieve, async (span) => {
        const retrieved = await this.repository.searchMemories({
          ...request,
          ...(queryEmbedding ? { queryEmbedding } : {})
        });
        span.setAttribute("memory.candidates.retrieved", retrieved.length);
        return retrieved;
      });
    });
  }

  private optionalEmbedding(
    text: string
  ): Promise<readonly number[] | undefined> {
    if (!this.embedder) return Promise.resolve(undefined);
    return this.withSpan(MEMORY_OPERATIONS.embed, async (span) => {
      try {
        return this.validateEmbedding(await this.embedder!.embed(text));
      } catch (error) {
        if (error instanceof MemoryEmbeddingUnavailableError) {
          span.setAttribute("memory.embedding.fallback", "lexical");
        }
        throw error;
      }
    }).catch((error: unknown) => {
      if (error instanceof MemoryEmbeddingUnavailableError) return undefined;
      throw error;
    });
  }

  private rerankMemories(
    hits: readonly MemorySearchHit[],
    context: MemoryReadContext,
    asOf: string,
    rejections: Map<MemoryReasonCode, number>
  ): Promise<readonly MemorySearchHit[]> {
    return this.withSpan(MEMORY_OPERATIONS.rerank, (span) => {
      const unique = new Map<string, MemorySearchHit>();
      for (const hit of hits) {
        if (!unique.has(hit.memory.id)) unique.set(hit.memory.id, hit);
      }
      const eligible: MemorySearchHit[] = [];
      for (const hit of unique.values()) {
        const reason = this.rejectionReason(hit, context, asOf);
        if (reason) addCount(rejections, reason);
        else eligible.push(hit);
      }
      const ordered = eligible
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RESEARCH_HITS);
      span.setAttribute("memory.candidates.reranked", ordered.length);
      for (const kind of ["episodic", "semantic", "procedural"] as const) {
        span.setAttribute(
          `memory.candidates.${kind}`,
          ordered.filter((hit) => hit.memory.kind === kind).length
        );
      }
      return ordered;
    });
  }

  private rejectionReason(
    hit: MemorySearchHit,
    context: MemoryReadContext,
    asOf: string
  ): MemoryReasonCode | null {
    const { memory } = hit;
    if (!isMemoryScopeVisibleTo(memory.scope, context)) return "scope_mismatch";
    if (memory.status === "superseded") return "superseded";
    if (memory.status === "invalidated") return "invalidated";
    if (memory.status !== "active" || memory.validity.state !== "verified")
      return "uncertain";
    if (
      memory.provenance.experienceIds.length === 0 ||
      memory.provenance.evidence.length === 0
    ) {
      return "missing_provenance";
    }
    if (
      (memory.validity.validFrom !== undefined &&
        memory.validity.validFrom > asOf) ||
      (memory.validity.validTo !== undefined && memory.validity.validTo <= asOf)
    ) {
      return "stale";
    }
    if (!Number.isFinite(hit.score)) return "low_relevance";
    return null;
  }

  private async reconstructMemories(
    ranked: readonly MemorySearchHit[],
    request: MemoryResearchRequest,
    rejections: Map<MemoryReasonCode, number>
  ): Promise<MemoryPacket["entries"]> {
    const entries: MemoryPacket["entries"][number][] = [];
    // Rank order is the packet priority order. Keep expensive verifier/model
    // adapters sequential and bounded rather than fanning out up to 40 calls.
    /* eslint-disable no-await-in-loop -- preserve rank order and cap verifier/reconstructor concurrency */
    for (const { memory } of ranked) {
      const assessment = await this.withSpan(
        MEMORY_OPERATIONS.validate,
        (span) =>
          this.verify(memory, request).then((result) => {
            span.setAttribute(
              MEMORY_SPAN_ATTRIBUTES.validation,
              result.compatibility
            );
            return result;
          })
      );
      if (
        assessment.compatibility !== "compatible" ||
        assessment.evidence.length === 0
      ) {
        addCount(
          rejections,
          assessment.compatibility === "contradicted"
            ? "contradicted"
            : "uncertain"
        );
        continue;
      }
      const review = await this.withSpan(
        MEMORY_OPERATIONS.reconstruct,
        async (span) => {
          const result = await this.reconstructor.reconstruct({
            memory,
            task: request.task,
            assessment
          });
          span.setAttribute("memory.review.disposition", result.disposition);
          return result;
        }
      );
      const guidance = review.guidance?.trim();
      const approvedDisposition =
        review.disposition === "retain" || review.disposition === "revise";
      if (!approvedDisposition || !guidance) {
        addCount(
          rejections,
          review.disposition === "reject"
            ? "low_relevance"
            : review.disposition === "uncertain"
              ? "uncertain"
              : "rejected"
        );
        continue;
      }
      entries.push({
        memoryId: memory.id,
        disposition: review.disposition,
        guidance: redactSensitiveText(guidance),
        rationale: redactSensitiveText(review.rationale.trim()),
        evidence: mergeEvidence(memory.provenance.evidence, assessment.evidence)
      });
    }
    /* eslint-enable no-await-in-loop */
    return entries;
  }

  private recordResearchResults(
    span: Span,
    retrieved: readonly MemorySearchHit[],
    reconstructed: MemoryPacket["entries"],
    packet: MemoryPacket,
    rejections: ReadonlyMap<MemoryReasonCode, number>
  ): void {
    const kindById = new Map(
      retrieved.map(({ memory }) => [memory.id, memory.kind] as const)
    );
    for (const entry of reconstructed) {
      recordMemoryMetric(() =>
        this.metrics.candidates.add(1, {
          "autodev.memory.candidate.stage":
            entry.disposition === "retain" ? "retained" : "revised",
          "autodev.memory.kind": kindById.get(entry.memoryId) ?? "unknown"
        })
      );
    }
    for (const [reason, count] of rejections) {
      recordMemoryMetric(() =>
        this.metrics.candidates.add(count, {
          "autodev.memory.candidate.stage": "rejected",
          "autodev.memory.reason": reason
        })
      );
      span.setAttribute(`memory.candidates.rejected.${reason}`, count);
    }
    const includedIds = new Set(packet.entries.map((entry) => entry.memoryId));
    for (const entry of reconstructed) {
      recordMemoryMetric(() =>
        this.metrics.candidates.add(1, {
          "autodev.memory.candidate.stage": includedIds.has(entry.memoryId)
            ? "packet_included"
            : "packet_omitted",
          "autodev.memory.kind": kindById.get(entry.memoryId) ?? "unknown"
        })
      );
    }
    span.setAttribute(
      "memory.candidates.retained",
      reconstructed.filter((entry) => entry.disposition === "retain").length
    );
    span.setAttribute(
      "memory.candidates.revised",
      reconstructed.filter((entry) => entry.disposition === "revise").length
    );
    span.setAttribute("memory.candidates.rejected", rejectionTotal(rejections));
    recordMemoryMetric(() =>
      this.metrics.packetCharacters.record(packet.characterCount)
    );
    if (packet.tokenCount !== undefined)
      recordMemoryMetric(() =>
        this.metrics.packetTokens.record(packet.tokenCount!)
      );
  }

  private async verify(
    memory: MemoryRecord,
    request: MemoryResearchRequest
  ): Promise<CurrentStateAssessment> {
    const result = await this.verifier.verify({
      memory,
      task: request.task,
      context: request.context,
      asOf: request.asOf ?? this.now()
    });
    const reasonCode = MEMORY_REASON_CODE_SET.has(result.reasonCode)
      ? result.reasonCode
      : "unknown";
    const incompleteCompatibleAssessment =
      result.compatibility === "compatible" &&
      (!result.source.trim() ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        result.evidence.length === 0);
    return {
      ...result,
      evidence: sanitizeEvidence(result.evidence),
      compatibility: incompleteCompatibleAssessment
        ? "unknown"
        : result.compatibility,
      reasonCode: incompleteCompatibleAssessment ? "unknown" : reasonCode
    };
  }

  private async commit(
    changes: readonly MemoryVersionedUpdate[],
    events: readonly MemoryLifecycleEvent[]
  ): Promise<void> {
    const succeeded = await this.repository.transitionMemories(changes, events);
    if (!succeeded)
      throw new MemoryConflictError(
        "Memory changed concurrently; reload its current history."
      );
  }

  private event(input: {
    readonly memoryId: string;
    readonly action: MemoryLifecycleAction;
    readonly actor: MemoryActor;
    readonly fromStatus?: MemoryStatus;
    readonly toStatus: MemoryStatus;
    readonly reasonCode: MemoryReasonCode;
    readonly evidence: readonly EvidenceReference[];
    readonly relatedMemoryIds?: readonly string[];
  }): MemoryLifecycleEvent {
    return {
      id: this.createId(),
      memoryId: input.memoryId,
      action: input.action,
      actorId: input.actor.id,
      occurredAt: this.now(),
      ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
      toStatus: input.toStatus,
      reasonCode: input.reasonCode,
      evidence: sanitizeEvidence(input.evidence),
      relatedMemoryIds: input.relatedMemoryIds ?? []
    };
  }

  private boundPacket(
    request: MemoryResearchRequest,
    entries: MemoryPacket["entries"]
  ): MemoryPacket {
    const included: MemoryPacket["entries"][number][] = [];
    let text = "";
    let tokenCount: number | undefined = this.countTokens?.("");
    let omittedCount = 0;
    for (const entry of entries) {
      const nextEntries = [...included, entry];
      const nextText = renderPacket(nextEntries);
      const nextTokens = this.countTokens?.(nextText);
      if (
        nextText.length > request.maxPacketCharacters ||
        (request.maxPacketTokens !== undefined &&
          nextTokens !== undefined &&
          nextTokens > request.maxPacketTokens)
      ) {
        omittedCount += 1;
        continue;
      }
      included.push(entry);
      text = nextText;
      tokenCount = nextTokens;
    }
    return {
      taskId: request.taskId,
      entries: included,
      text,
      characterCount: text.length,
      ...(tokenCount === undefined ? {} : { tokenCount }),
      omittedCount,
      generatedAt: this.now()
    };
  }

  private isEligibleRecord(memory: MemoryRecord, asOf: string): boolean {
    return (
      memory.status === "active" &&
      memory.validity.state === "verified" &&
      (memory.validity.validFrom === undefined ||
        memory.validity.validFrom <= asOf) &&
      (memory.validity.validTo === undefined ||
        memory.validity.validTo > asOf) &&
      memory.provenance.experienceIds.length > 0 &&
      memory.provenance.evidence.length > 0
    );
  }

  private validateEmbedding(embedding: readonly number[]): readonly number[] {
    if (
      embedding.length === 0 ||
      embedding.length > 4096 ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new MemoryValidationError(
        "Memory embedding must be a bounded finite vector."
      );
    }
    return embedding;
  }

  private assertExperienceScope(experience: ExperienceEnvelope): void {
    if (
      experience.scope.kind === "global" ||
      experience.scope.workspaceId !== experience.workspaceId
    ) {
      throw new MemoryValidationError(
        "Experience must retain its explicit workspace scope."
      );
    }
    if (
      !experience.trajectory.uri.trim() ||
      !experience.trajectory.format.trim()
    )
      throw new MemoryValidationError(
        "Experience requires a trajectory reference and format."
      );
    try {
      assertTrajectoryProvenance(experience.trajectory);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MemoryValidationError(error.message);
      }
      throw error;
    }
    if (
      !Number.isFinite(Date.parse(experience.startedAt)) ||
      (experience.completedAt !== undefined &&
        (!Number.isFinite(Date.parse(experience.completedAt)) ||
          experience.completedAt < experience.startedAt))
    ) {
      throw new MemoryValidationError(
        "Experience timestamps must be valid and completion cannot precede start."
      );
    }
  }

  private assertQuery(query: string): void {
    if (!query.trim() || query.length > MAX_QUERY_LENGTH)
      throw new MemoryValidationError(
        "Memory query must be non-empty and bounded."
      );
  }

  private assertExperienceOutcomes(
    outcomes: ExperienceListRequest["outcomes"]
  ): void {
    if (
      outcomes !== undefined &&
      (outcomes.length > EXPERIENCE_OUTCOMES.length ||
        outcomes.some((outcome) => !EXPERIENCE_OUTCOMES.includes(outcome)))
    ) {
      throw new MemoryValidationError(
        "Memory experience outcome filter is invalid."
      );
    }
  }

  private assertMemoryModes(modes: ExperienceListRequest["memoryModes"]): void {
    if (
      modes !== undefined &&
      (modes.length > MEMORY_EXECUTION_MODES.length ||
        modes.some((mode) => !isMemoryExecutionMode(mode)))
    ) {
      throw new MemoryValidationError(
        "Memory experience mode filter is invalid."
      );
    }
  }

  private assertOptionalQuery(query: string | undefined): void {
    if (query !== undefined && query.length > MAX_QUERY_LENGTH)
      throw new MemoryValidationError(
        "Memory query exceeds its character bound."
      );
  }

  private assertTaskKind(taskKind: string | undefined): void {
    if (
      taskKind !== undefined &&
      (!taskKind.trim() || taskKind.length > MAX_TASK_KIND_LENGTH)
    ) {
      throw new MemoryValidationError(
        "Memory task kind must be non-empty and bounded."
      );
    }
  }

  private pageRequest(
    limit: number | undefined,
    offset: number | undefined
  ): { limit: number; offset: number } {
    const resolvedLimit = limit ?? 50;
    const resolvedOffset = offset ?? 0;
    if (
      !Number.isSafeInteger(resolvedLimit) ||
      resolvedLimit < 1 ||
      resolvedLimit > 100 ||
      !Number.isSafeInteger(resolvedOffset) ||
      resolvedOffset < 0 ||
      resolvedOffset > MAX_LIST_OFFSET
    ) {
      throw new MemoryValidationError("Memory page bounds are invalid.");
    }
    return { limit: resolvedLimit, offset: resolvedOffset };
  }

  private assertActor(actor: MemoryActor): void {
    if (!actor.id.trim())
      throw new MemoryAuthorizationError("Memory actor is required.");
  }

  private assertCurator(actor: MemoryActor): void {
    this.assertActor(actor);
    if (actor.authority !== "root" && actor.authority !== "curator")
      throw new MemoryAuthorizationError(
        "Only the root or memory curator may change shared memory state."
      );
  }

  private withSpan<T>(
    name: MemoryOperationName,
    operation: (span: Span) => Promise<T> | T
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      const startedAt = performance.now();
      let outcome: "success" | "error" = "success";
      try {
        return await operation(span);
      } catch (error) {
        outcome = "error";
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("error.type", memoryErrorType(error));
        throw error;
      } finally {
        const attributes = {
          "autodev.memory.operation": name,
          "autodev.memory.outcome": outcome
        };
        try {
          recordMemoryMetric(() => this.metrics.operations.add(1, attributes));
          recordMemoryMetric(() =>
            this.metrics.operationDuration.record(
              Math.max(0, (performance.now() - startedAt) / 1000),
              { "autodev.memory.operation": name }
            )
          );
        } finally {
          span.end();
        }
      }
    });
  }
}

function memoryErrorType(error: unknown): string {
  if (error instanceof MemoryAuthorizationError) return "authorization";
  if (error instanceof MemoryConflictError) return "conflict";
  if (error instanceof MemoryValidationError) return "invalid_input";
  return error instanceof Error ? "operation_failed" : "unknown";
}

const MEMORY_REASON_CODE_SET = new Set<string>(MEMORY_REASON_CODES);

const ALLOWED_REJECTION_REASONS: ReadonlySet<MemoryReasonCode> = new Set([
  "stale",
  "contradicted",
  "superseded",
  "low_relevance",
  "uncertain",
  "rejected",
  "unknown",
  "scope_mismatch",
  "invalidated",
  "missing_provenance"
]);

function addCount(counts: Map<MemoryReasonCode, number>, reason: string): void {
  const bounded: MemoryReasonCode = ALLOWED_REJECTION_REASONS.has(
    reason as MemoryReasonCode
  )
    ? (reason as MemoryReasonCode)
    : "unknown";
  counts.set(bounded, (counts.get(bounded) ?? 0) + 1);
}

function rejectionTotal(counts: ReadonlyMap<MemoryReasonCode, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function mergeEvidence(
  original: readonly EvidenceReference[],
  verified: readonly EvidenceReference[]
): readonly EvidenceReference[] {
  const unique = new Map<string, EvidenceReference>();
  for (const reference of [...original, ...verified]) {
    unique.set(
      `${reference.kind}\u0000${reference.uri}\u0000${reference.revision ?? ""}`,
      reference
    );
  }
  return [...unique.values()];
}

function renderPacket(entries: MemoryPacket["entries"]): string {
  return entries
    .map((entry) => {
      const citations = entry.evidence.map((item) => item.uri).join(", ");
      return [
        `Memory ${entry.memoryId} (${entry.disposition})`,
        entry.guidance,
        entry.rationale ? `Applicability: ${entry.rationale}` : "",
        citations ? `Evidence: ${citations}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function scopeKey(memory: MemoryRecord): string {
  const scope = memory.scope;
  switch (scope.kind) {
    case "global": {
      return "global";
    }
    case "workspace": {
      return `workspace:${scope.workspaceId}`;
    }
    case "repository": {
      return `repository:${scope.workspaceId}:${scope.repositoryId}`;
    }
    case "role": {
      return `role:${scope.workspaceId}:${scope.repositoryId ?? "*"}:${scope.role}`;
    }
    case "task": {
      return `task:${scope.workspaceId}:${scope.taskId}:${scope.runId}`;
    }
    case "agent": {
      return `agent:${scope.workspaceId}:${scope.taskId}:${scope.runId}:${scope.agentId}`;
    }
    default: {
      const exhaustive: never = scope;
      throw new Error(
        `Unhandled MemoryScope kind: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}
