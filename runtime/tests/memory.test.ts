import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Meter, Tracer } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import {
  emptyMemoryStatusCounts,
  type EvidenceReference,
  type ExperienceEnvelope,
  isMemoryExperienceVisibleTo,
  type MemoryActor,
  type ExperienceListRequest,
  type ExperienceSearchRequest,
  type ExperienceOutcome,
  type MemoryExperiencePurgeRequest,
  type MemoryExperiencePurgeResult,
  type MemoryExperiencePurgeReason,
  type MemoryExpiredExperienceRequest,
  type MemoryHistory,
  type MemoryInjectionEvent,
  type MemoryInjectionEventSessionLookup,
  type MemoryInjectionOutcomeCohortFilter,
  type MemoryInjectionUseCohortCell,
  type MemoryInjectionUseCohortFilter,
  type MemoryInjectionUseCohortPage,
  type MemoryInjectionUseJoin,
  type MemoryInjectionUseJoinPage,
  type MemoryInjectionUseJoinRequest,
  type MemoryInjectionOutcomeJoin,
  type MemoryInjectionOutcomeJoinPage,
  type MemoryInjectionOutcomeJoinRequest,
  type MemoryLifecycleEvent,
  type MemoryExecutionMode,
  type MemoryInjectionResult,
  type MemoryOutcomeReport,
  type MemoryOutcomeReportKind,
  type MemoryUseKind,
  type MemoryPacket,
  type MemoryReadContext,
  type MemoryRecord,
  type MemoryRecordInjectionEventInput,
  type MemoryRecordOutcomeReportInput,
  type MemoryRecordSessionOutcomeReportInput,
  type MemoryRecordUseReportInput,
  type MemoryRepository,
  type MemoryResearchRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemorySessionOutcomeCohortFilter,
  type MemorySessionOutcomeCohortPage,
  type MemorySessionOutcomeReport,
  type MemoryStatusCounts,
  type MemoryUseReport,
  type MemoryVersionedUpdate,
  sessionOutcomeReportBodyMatches,
  useReportBodyMatches
} from "@simulatorlife/autodev-core";
import { MemoryConflictError as RepositoryMemoryConflictError } from "@simulatorlife/autodev-data";

import { injectMemoryContext } from "../src/memory/context-injection.ts";
import { createMemoryMcpServer } from "../src/memory/mcp.ts";
import { sanitizeEvidenceReference } from "../src/memory/privacy.ts";
import {
  type CurrentStateAssessment,
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryEmbeddingUnavailableError,
  MemoryService,
  type MemorySkillPromotionWriter,
  MemoryValidationError
} from "../src/memory/service.ts";
import { RuleSyncMemorySkillPromoter } from "../src/memory/skill-promotion.ts";

/**
 * The reconstructor contract the service declares, which is narrower than
 * `MemoryReviewDisposition`: "not_evaluated" is not a reconstruction result
 * the service accepts back.
 */
type ReconstructionOutcome = {
  readonly disposition: "retain" | "revise" | "reject" | "uncertain";
  readonly guidance?: string;
  readonly rationale: string;
};

const context: MemoryReadContext = {
  workspaceId: "workspace-a",
  repositoryId: "repo-a",
  role: "worker",
  taskId: "task-current",
  runId: "run-current",
  agentId: "agent-current",
  canReadGlobal: false
};
const worker: MemoryActor = {
  id: "agent-current",
  authority: "worker",
  role: "worker"
};
const root: MemoryActor = { id: "root-agent", authority: "root" };
const EXPERIENCE_TIME_COLLATOR = new Intl.Collator();

const source: EvidenceReference = {
  kind: "commit",
  uri: "git://workspace-a/repo-a/commit/abc123",
  revision: "abc123"
};

class FakeMemoryRepository implements MemoryRepository {
  readonly experiences = new Map<string, ExperienceEnvelope>();
  readonly memories = new Map<string, MemoryRecord>();
  readonly injectionEvents = new Map<string, MemoryInjectionEvent>();
  readonly outcomeReportResults: {
    readonly appended: boolean;
    readonly id: string;
  }[] = [];
  readonly outcomeReports = new Map<string, MemoryOutcomeReport>();
  readonly outcomeJoinRequests: MemoryInjectionOutcomeJoinRequest[] = [];
  readonly experienceListRequests: ExperienceListRequest[] = [];
  readonly experienceSearchRequests: ExperienceSearchRequest[] = [];
  readonly outcomeReportLookups: {
    readonly lookupContext: MemoryInjectionEventSessionLookup;
    readonly correlationToken: string;
  }[] = [];
  readonly sessionOutcomeReports = new Map<
    string,
    MemorySessionOutcomeReport
  >();
  readonly sessionOutcomeReportResults: {
    readonly appended: boolean;
    readonly id: string;
  }[] = [];
  readonly events: MemoryLifecycleEvent[] = [];
  hits: readonly MemorySearchHit[] = [];
  readonly searchRequests: MemorySearchRequest[] = [];
  readonly proposalEmbeddings: (readonly number[] | undefined)[] = [];
  readonly purgeRequests: MemoryExperiencePurgeRequest[] = [];
  readonly outcomeCohortRequests: MemoryInjectionOutcomeCohortFilter[] = [];
  readonly sessionOutcomeCohortRequests: MemorySessionOutcomeCohortFilter[] =
    [];
  readonly useReports = new Map<string, MemoryUseReport>();
  readonly useReportResults: {
    readonly appended: boolean;
    readonly id: string;
  }[] = [];
  readonly useJoinRequests: MemoryInjectionUseJoinRequest[] = [];
  readonly useCohortRequests: MemoryInjectionUseCohortFilter[] = [];
  failNextTransition = false;

  async appendExperience(envelope: ExperienceEnvelope): Promise<void> {
    if (this.experiences.has(envelope.id))
      throw new RepositoryMemoryConflictError("duplicate experience");
    this.experiences.set(envelope.id, envelope);
  }

  async getExperience(id: string): Promise<ExperienceEnvelope | null> {
    return this.experiences.get(id) ?? null;
  }

  async searchExperiences(
    request: ExperienceSearchRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    this.experienceSearchRequests.push(request);
    return [...this.experiences.values()];
  }

  async listExperiences(
    request: ExperienceListRequest
  ): Promise<{
    items: readonly ExperienceEnvelope[];
    total: number;
    limit: number;
    offset: number;
  }> {
    this.experienceListRequests.push(request);
    const items = [...this.experiences.values()];
    return { items, total: items.length, limit: 50, offset: 0 };
  }

  async listExpiredExperiences(
    request: MemoryExpiredExperienceRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    const cutoff = Date.parse(request.completedBefore);
    const referenced = new Set(
      [...this.memories.values()].flatMap(
        (memory) => memory.provenance.experienceIds
      )
    );
    return [...this.experiences.values()]
      .filter(
        (item) =>
          item.completedAt &&
          Date.parse(item.completedAt) < cutoff &&
          isMemoryExperienceVisibleTo(item, request.context) &&
          !referenced.has(item.id)
      )
      .sort((left, right) =>
        EXPERIENCE_TIME_COLLATOR.compare(
          String(left.completedAt),
          String(right.completedAt)
        )
      )
      .slice(0, request.limit);
  }

  async purgeExperience(
    request: MemoryExperiencePurgeRequest
  ): Promise<MemoryExperiencePurgeResult> {
    this.purgeRequests.push(request);
    const storedExperience = this.experiences.get(request.experienceId);
    if (!storedExperience) return "not_visible";
    if (
      [...this.memories.values()].some((memory) =>
        memory.provenance.experienceIds.includes(request.experienceId)
      )
    ) {
      return "referenced_by_memory";
    }
    this.experiences.delete(request.experienceId);
    return "purged";
  }

  async proposeMemory(
    candidate: MemoryRecord,
    event: MemoryLifecycleEvent,
    embedding?: readonly number[]
  ): Promise<void> {
    assert.equal(candidate.status, "proposed");
    assert.equal(candidate.validity.state, "unverified");
    if (
      candidate.provenance.experienceIds.some((id) => !this.experiences.has(id))
    )
      throw new Error("experience provenance missing");
    this.memories.set(candidate.id, candidate);
    this.events.push(event);
    this.proposalEmbeddings.push(embedding);
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    return this.memories.get(id) ?? null;
  }

  async searchMemories(
    request: MemorySearchRequest
  ): Promise<readonly MemorySearchHit[]> {
    this.searchRequests.push(request);
    return this.hits.slice(0, request.limit ?? this.hits.length);
  }

  async listMemories(): Promise<{
    items: readonly MemoryRecord[];
    total: number;
    limit: number;
    offset: number;
    statusCounts: MemoryStatusCounts;
  }> {
    const items = [...this.memories.values()];
    const measured: Record<string, number> = { ...emptyMemoryStatusCounts() };
    for (const memory of items) {
      measured[memory.status] = (measured[memory.status] ?? 0) + 1;
    }
    return {
      items,
      total: items.length,
      limit: 50,
      offset: 0,
      statusCounts: measured as MemoryStatusCounts
    };
  }

  async getMemoryHistory(id: string): Promise<MemoryHistory | null> {
    const memory = this.memories.get(id);
    if (!memory) return null;
    return {
      memory,
      relatedMemories: [],
      events: this.events.filter((event) => event.memoryId === id)
    };
  }

  async transitionMemories(
    changes: readonly MemoryVersionedUpdate[],
    events: readonly MemoryLifecycleEvent[]
  ): Promise<boolean> {
    if (this.failNextTransition) {
      this.failNextTransition = false;
      return false;
    }
    if (
      changes.some(
        (change) =>
          this.memories.get(change.next.id)?.updatedAt !==
          change.expectedUpdatedAt
      )
    ) {
      return false;
    }
    for (const change of changes)
      this.memories.set(change.next.id, change.next);
    this.events.push(...events);
    return true;
  }

  async recordInjectionEvent(input: MemoryRecordInjectionEventInput): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    const { event } = input;
    if (this.injectionEvents.has(event.correlationToken)) {
      return { appended: false, id: event.id };
    }
    this.injectionEvents.set(event.correlationToken, event);
    return { appended: true, id: event.id };
  }

  async recordOutcomeReport(input: MemoryRecordOutcomeReportInput): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    // Stored so the session join has reports to attach; the queued result still
    // decides what the write reports back, which several tests drive directly.
    this.outcomeReports.set(input.report.correlationToken, input.report);
    return (
      this.outcomeReportResults.shift() ?? {
        appended: false,
        id: input.report.id
      }
    );
  }

  async recordSessionOutcomeReport(
    input: MemoryRecordSessionOutcomeReportInput
  ): Promise<{
    readonly appended: boolean;
    readonly id: string;
  }> {
    const key = `${input.report.workspaceId}\u0000${input.report.repositoryId}\u0000${input.report.taskId}`;
    const result = this.sessionOutcomeReportResults.shift();
    if (result) return result;
    const existing = this.sessionOutcomeReports.get(key);
    if (existing) {
      if (sessionOutcomeReportBodyMatches(existing, input.report)) {
        return { appended: false, id: existing.id };
      }
      throw new RepositoryMemoryConflictError(
        "Session outcome report conflicts with existing report."
      );
    }
    this.sessionOutcomeReports.set(key, input.report);
    return { appended: true, id: input.report.id };
  }

  async getSessionOutcomeReport(
    workspaceId: string,
    repositoryId: string,
    taskId: string
  ): Promise<MemorySessionOutcomeReport | null> {
    const key = `${workspaceId}\u0000${repositoryId}\u0000${taskId}`;
    return this.sessionOutcomeReports.get(key) ?? null;
  }

  async findInjectionEventByTokenForSession(
    lookupContext: MemoryInjectionEventSessionLookup,
    correlationToken: string
  ): Promise<MemoryInjectionEvent | null> {
    this.outcomeReportLookups.push({ lookupContext, correlationToken });
    const event = this.injectionEvents.get(correlationToken);
    if (!event) return null;
    // The stored event keeps its own request-level runId/agentId; this join is
    // on the session key alone, so those are deliberately not compared.
    if (event.workspaceId !== lookupContext.workspaceId) return null;
    if (
      lookupContext.repositoryId !== undefined &&
      event.repositoryId !== lookupContext.repositoryId
    )
      return null;
    if (event.taskId !== lookupContext.taskId) return null;
    return event;
  }

  async getInjectionEventByIdForSession(
    lookupContext: MemoryInjectionEventSessionLookup,
    injectionEventId: string
  ): Promise<MemoryInjectionEvent | null> {
    for (const event of this.injectionEvents.values()) {
      if (event.id !== injectionEventId) continue;
      if (event.workspaceId !== lookupContext.workspaceId) continue;
      if (
        lookupContext.repositoryId !== undefined &&
        event.repositoryId !== lookupContext.repositoryId
      )
        continue;
      if (event.taskId !== lookupContext.taskId) continue;
      return event;
    }
    return null;
  }

  async recordInjectionUseReport(
    input: MemoryRecordUseReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    const queued = this.useReportResults.shift();
    if (queued) return queued;
    const key = `${input.report.workspaceId}\u0000${input.report.correlationToken}`;
    const stored = this.useReports.get(key);
    if (stored) {
      if (useReportBodyMatches(stored, input.report)) {
        return { appended: false, id: stored.id };
      }
      throw new RepositoryMemoryConflictError(
        "Injection use report conflicts with previously recorded report."
      );
    }
    this.useReports.set(key, input.report);
    return { appended: true, id: input.report.id };
  }

  async getInjectionUseReport(
    workspaceId: string,
    correlationToken: string
  ): Promise<MemoryUseReport | null> {
    const key = `${workspaceId}\u0000${correlationToken}`;
    return this.useReports.get(key) ?? null;
  }

  async listInjectionUseJoins(
    request: MemoryInjectionUseJoinRequest
  ): Promise<MemoryInjectionUseJoinPage> {
    this.useJoinRequests.push(request);
    const items: MemoryInjectionUseJoin[] = [];
    for (const event of this.injectionEvents.values()) {
      if (
        request.context.workspaceId !== event.workspaceId ||
        request.context.taskId !== event.taskId ||
        (request.context.repositoryId !== undefined &&
          request.context.repositoryId !== event.repositoryId)
      ) {
        continue;
      }
      if (event.injectionResult !== "injected") continue;
      if (event.memoryIds.length === 0) continue;
      if (
        request.memoryModes &&
        !request.memoryModes.includes(event.memoryMode)
      )
        continue;
      const report = this.useReports.get(
        `${event.workspaceId}\u0000${event.correlationToken}`
      );
      if (!report && request.includeUnassessed !== true) continue;
      if (
        report &&
        request.useKinds &&
        !request.useKinds.includes(report.useKind)
      )
        continue;
      items.push({
        injection: event,
        use: report ?? null,
        sessionInjectionCount: 1
      });
    }
    const total = items.length;
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 50;
    return {
      items: items.slice(offset, offset + limit),
      total,
      limit,
      offset
    };
  }

  async aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage> {
    this.useCohortRequests.push(request);
    const eligibleModes = new Set(["jit", "retrieval-only"]);
    const cells: MemoryInjectionUseCohortCell[] = [];
    let exposureCount = 0;
    for (const event of this.injectionEvents.values()) {
      if (
        event.workspaceId !== request.context.workspaceId ||
        (request.context.repositoryId !== undefined &&
          event.repositoryId !== request.context.repositoryId)
      )
        continue;
      if (event.injectionResult !== "injected") continue;
      if (event.memoryIds.length === 0) continue;
      if (!eligibleModes.has(event.memoryMode)) continue;
      if (
        request.memoryModes &&
        !request.memoryModes.includes(
          event.memoryMode as MemoryInjectionUseCohortCell["memoryMode"]
        )
      )
        continue;
      const report = this.useReports.get(
        `${event.workspaceId}\u0000${event.correlationToken}`
      );
      if (
        request.useKinds &&
        (!report || !request.useKinds.includes(report.useKind))
      )
        continue;
      exposureCount += 1;
      cells.push({
        memoryMode:
          event.memoryMode as MemoryInjectionUseCohortCell["memoryMode"],
        sessionCardinality: "single",
        useKind: report?.useKind ?? null,
        exposureCount: 1
      });
    }
    return {
      schema: "autodev-memory-injection-use-cohorts-v1",
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId ?? "",
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells,
      exposureCount
    };
  }

  async listInjectionOutcomeJoins(
    request: MemoryInjectionOutcomeJoinRequest
  ): Promise<MemoryInjectionOutcomeJoinPage> {
    this.outcomeJoinRequests.push(request);
    // Rows are matched on the session key alone, never the request-level
    // runId/agentId the stored events carry.
    const session = [...this.injectionEvents.values()].filter(
      (event) =>
        event.workspaceId === request.context.workspaceId &&
        event.taskId === request.context.taskId &&
        (request.context.repositoryId === undefined ||
          event.repositoryId === request.context.repositoryId)
    );
    const items: MemoryInjectionOutcomeJoin[] = [];
    for (const event of session) {
      if (
        request.memoryModes &&
        !request.memoryModes.includes(event.memoryMode)
      )
        continue;
      if (
        request.injectionResults &&
        !request.injectionResults.includes(event.injectionResult)
      )
        continue;
      const outcome = this.outcomeReports.get(event.correlationToken) ?? null;
      if (!outcome && request.includeUnreported !== true) continue;
      if (
        outcome &&
        request.outcomeKinds &&
        !request.outcomeKinds.includes(outcome.outcomeKind)
      )
        continue;
      if (
        outcome &&
        request.reportKinds &&
        !request.reportKinds.includes(outcome.reportKind)
      )
        continue;
      items.push({
        injection: event,
        outcome,
        sessionInjectionCount: session.length
      });
    }
    const limit = request.limit ?? 50;
    const offset = request.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset
    };
  }

  async aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ) {
    this.outcomeCohortRequests.push(request);
    return {
      schema: "autodev-memory-injection-outcome-cohorts-v1" as const,
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId!,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells: [],
      exposureCount: 0,
      reportCount: 0
    };
  }

  async aggregateSessionOutcomeCohorts(
    request: MemorySessionOutcomeCohortFilter
  ): Promise<MemorySessionOutcomeCohortPage> {
    this.sessionOutcomeCohortRequests.push(request);
    return {
      schema: "autodev-memory-session-outcome-cohorts-v1" as const,
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId!,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells: [],
      sessionCount: 0,
      reportedSessionCount: 0,
      unreportedSessionCount: 0,
      conflictingOutcomeSessionCount: 0,
      mixedModeSessionCount: 0
    };
  }
}

function experience(id = "experience-1"): ExperienceEnvelope {
  return {
    id,
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    scope: {
      kind: "repository",
      workspaceId: "workspace-a",
      repositoryId: "repo-a"
    },
    taskId: "task-old",
    runId: "run-old",
    agentId: worker.id,
    agentRole: "worker",
    outcome: "success",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    trajectory: {
      format: "codex-rollout",
      uri: "file:///private/trajectory.jsonl",
      recordCount: 4
    },
    evidence: [source]
  };
}

function record(
  id: string,
  overrides: Partial<MemoryRecord> = {}
): MemoryRecord {
  const timestamp = "2026-09-15T12:00:00.000Z";
  return {
    id,
    kind: "procedural",
    scope: {
      kind: "repository",
      workspaceId: "workspace-a",
      repositoryId: "repo-a"
    },
    claim: "Run the focused suite before broad validation.",
    status: "active",
    provenance: {
      experienceIds: ["experience-1"],
      evidence: [source],
      createdBy: "curator",
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
      verificationSource: "current-state-test"
    },
    validity: { state: "verified", checkedAt: timestamp, evidence: [source] },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function compatibleAssessment(): CurrentStateAssessment {
  return {
    compatibility: "compatible",
    source: "git-and-rulesync",
    checkedAt: "2026-09-30T10:00:00.000Z",
    evidence: [source],
    reasonCode: "verified_current_state"
  };
}

function makeService(
  repository: FakeMemoryRepository,
  options: {
    readonly assessment?: (memory: MemoryRecord) => CurrentStateAssessment;
    readonly countTokens?: (text: string) => number;
    readonly makeId?: () => string;
    readonly embedder?: { embed(text: string): Promise<readonly number[]> };
    readonly tracer?: Tracer;
    readonly meter?: Meter;
    readonly maxResearchCandidates?: number;
    readonly skillPromotionWriter?: MemorySkillPromotionWriter;
    /**
     * The reconstructor contract the service declares, which is narrower than
     * `MemoryReviewDisposition`: "not_evaluated" is not a reconstruction
     * result the service will accept back.
     */
    readonly reconstruct?: (memory: MemoryRecord) => ReconstructionOutcome;
  } = {}
): MemoryService {
  let id = 0;
  return new MemoryService({
    repository,
    verifier: {
      verify: async ({ memory }) =>
        options.assessment?.(memory) ?? compatibleAssessment()
    },
    reconstructor: {
      reconstruct: async ({ memory }) =>
        options.reconstruct?.(memory) ?? {
          disposition: "retain",
          guidance: `For this task, follow ${memory.claim}`,
          rationale: "Current state confirms the cited procedure."
        }
    },
    now: () => "2026-09-30T10:00:00.000Z",
    createId: options.makeId ?? (() => `generated-${++id}`),
    ...(options.countTokens ? { countTokens: options.countTokens } : {}),
    ...(options.embedder ? { embedder: options.embedder } : {}),
    ...(options.tracer ? { tracer: options.tracer } : {}),
    ...(options.meter ? { meter: options.meter } : {}),
    ...(typeof options.maxResearchCandidates === "number"
      ? { maxResearchCandidates: options.maxResearchCandidates }
      : {}),
    ...(options.skillPromotionWriter
      ? { skillPromotionWriter: options.skillPromotionWriter }
      : {})
  });
}

function researchRequest(
  overrides: Partial<MemoryResearchRequest> = {}
): MemoryResearchRequest {
  return {
    taskId: "task-current",
    task: "Update the memory repository implementation.",
    query: "memory repository implementation",
    context,
    maxPacketCharacters: 12_000,
    ...overrides
  };
}

function outcomeInjectionEvent(
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  return {
    id: "private-injection-id",
    workspaceId: context.workspaceId,
    ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}),
    scope: {
      kind: "repository",
      workspaceId: context.workspaceId,
      repositoryId: context.repositoryId!
    },
    taskId: context.taskId ?? "task-current",
    runId: "private-injection-run-id",
    agentId: "private-injection-agent-id",
    correlationToken: "private-correlation-token",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 32,
    packetTokenCount: 8,
    memoryIds: ["private-memory-id"],
    occurredAt: "2026-09-30T10:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [
      {
        kind: "commit",
        uri: "https://example.test/private-injection-evidence"
      }
    ],
    recordedBy: "private-recorder-id",
    ...overrides
  };
}

function outcomeReport(
  overrides: Partial<MemoryOutcomeReport> = {}
): MemoryOutcomeReport {
  return {
    id: "private-outcome-report-id",
    workspaceId: context.workspaceId,
    ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}),
    scope: {
      kind: "repository",
      workspaceId: context.workspaceId,
      repositoryId: context.repositoryId!
    },
    taskId: context.taskId ?? "task-current",
    runId: "private-report-run-id",
    agentId: "private-report-agent-id",
    correlationToken: "private-correlation-token",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-09-30T10:01:00.000Z",
    reporterId: "private-reporter-id",
    reporterAuthority: "worker",
    reasonCode: "reporter_supplied",
    evidence: [
      {
        kind: "document",
        uri: "https://example.test/private-report-evidence"
      }
    ],
    ...overrides
  };
}

function makeOutcomeMetricHarness(
  repository: FakeMemoryRepository,
  tracer?: Tracer
) {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000
  });
  const provider = new MeterProvider({ readers: [reader] });
  const service = makeService(repository, {
    meter: provider.getMeter("autodev.memory.outcome-test"),
    ...(tracer ? { tracer } : {})
  });
  return { exporter, provider, service };
}

function outcomeReportMetricPoints(exporter: InMemoryMetricExporter) {
  const metric = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((item) => item.descriptor.name === "autodev.memory.outcome_reports");
  assert.ok(metric, "outcome report counter should be exported");
  return metric.dataPoints;
}

function sessionOutcomeReportHelper(
  overrides: Partial<MemorySessionOutcomeReport> = {}
): MemorySessionOutcomeReport {
  return {
    id: "private-session-outcome-id",
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId!,
    taskId: context.taskId ?? "task-current",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-09-30T10:01:00.000Z",
    reporterId: "private-reporter-id",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [
      {
        kind: "document",
        uri: "https://example.test/private-session-report-evidence"
      }
    ],
    ...overrides
  };
}

function sessionOutcomeReportMetricPoints(exporter: InMemoryMetricExporter) {
  const metric = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find(
      (item) =>
        item.descriptor.name === "autodev.memory.session_outcome_reports"
    );
  assert.ok(metric, "session outcome report counter should be exported");
  return metric.dataPoints;
}

async function persistOutcomeInjection(
  repository: FakeMemoryRepository,
  service: MemoryService,
  event = outcomeInjectionEvent()
): Promise<MemoryInjectionEvent> {
  const result = await service.recordInjectionEvent({
    event,
    actor: root,
    context: {
      ...context,
      taskId: event.taskId,
      runId: event.runId,
      agentId: event.agentId
    }
  });
  assert.equal(result.appended, true);
  const stored = repository.injectionEvents.get(event.correlationToken);
  assert.ok(stored);
  assert.equal(stored.memoryMode, event.memoryMode);
  assert.equal(stored.injectionResult, event.injectionResult);
  return event;
}

test("workers append only their own raw execution references", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const envelope = experience();

  await service.appendExperience(envelope, worker, {
    ...context,
    taskId: "task-old",
    runId: "run-old"
  });
  assert.equal(
    repository.experiences.get(envelope.id)?.trajectory.uri,
    envelope.trajectory.uri
  );
  assert.equal("transcript" in repository.experiences.get(envelope.id)!, false);
  await assert.rejects(
    service.appendExperience(
      { ...envelope, id: "other", agentId: "different-agent" },
      worker,
      { ...context, taskId: "task-old", runId: "run-old" }
    ),
    MemoryAuthorizationError
  );
  await assert.rejects(
    service.appendExperience(
      { ...envelope, id: "global", scope: { kind: "global" } },
      root,
      { ...context, taskId: "task-old", runId: "run-old" }
    ),
    MemoryValidationError
  );
});

test("experience validation references are bounded and stripped of locator credentials", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const envelope: ExperienceEnvelope = {
    ...experience(),
    validation: {
      state: "passed",
      evidence: [
        {
          kind: "pull_request",
          uri: "https://example.invalid/repo/pull/12?token=do-not-persist"
        }
      ]
    }
  };

  await service.appendExperience(envelope, worker, {
    ...context,
    taskId: "task-old",
    runId: "run-old"
  });

  await assert.rejects(
    service.appendExperience(
      {
        ...envelope,
        id: "experience-partial-trajectory-provenance",
        trajectory: { ...envelope.trajectory, sourceAdapter: "codex" }
      },
      worker,
      { ...context, taskId: "task-old", runId: "run-old" }
    ),
    MemoryValidationError
  );

  const stored = repository.experiences.get(envelope.id);
  assert.equal(
    stored?.validation?.evidence[0]?.uri,
    "https://example.invalid/repo/pull/12"
  );
  assert.doesNotMatch(JSON.stringify(stored), /do-not-persist/);
  await assert.rejects(
    service.appendExperience(
      {
        ...envelope,
        id: "experience-too-many-validation-refs",
        validation: {
          ...envelope.validation!,
          evidence: Array.from({ length: 65 }, () => ({
            kind: "commit" as const,
            uri: "git://workspace-a/repo-a/commit/abc123"
          }))
        }
      },
      worker,
      { ...context, taskId: "task-old", runId: "run-old" }
    ),
    MemoryValidationError
  );
});

test("captureExperience normalizes a native transcript and persists only its source reference envelope", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const { trajectory: _previousReference, ...metadata } = experience();
  const transcript = [
    {
      type: "response_item",
      timestamp: "2026-09-30T10:00:00Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "private task prompt token=do-not-persist"
          }
        ]
      }
    },
    {
      type: "response_item",
      timestamp: "2026-09-30T10:00:01Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "private assistant response" }]
      }
    }
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");

  const normalized = await service.captureExperience(
    {
      source: "codex",
      transcript,
      trajectoryUri: "https://memory.example/run?token=do-not-persist",
      experience: metadata
    },
    worker,
    { ...context, taskId: "task-old", runId: "run-old" }
  );

  const stored = repository.experiences.get("experience-1");
  assert.equal(stored?.trajectory.format, "letta-trajectory-v1");
  assert.equal(stored?.trajectory.recordCount, 3);
  assert.equal(stored?.trajectory.sourceAdapter, "codex");
  assert.equal(stored?.trajectory.normalizerId, "@letta-ai/trajectory");
  assert.equal(
    stored?.trajectory.normalizerVersion,
    normalized.normalizerVersion
  );
  assert.deepEqual(
    stored?.trajectory.diagnosticCodes,
    normalized.diagnosticCodes
  );
  assert.equal(stored?.trajectory.uri, "https://memory.example/run");
  assert.doesNotMatch(
    JSON.stringify(stored),
    /private task prompt|private assistant response|do-not-persist/
  );
});

test("capture refuses a transcript that contains no conversation to learn from", async () => {
  // A metadata-only transcript is a session that was opened and never used.
  // Storing an experience for it would create a durable record -- with a
  // trajectory digest, a task reference, and eventually derived memories pointing
  // this way -- describing a conversation that did not happen.
  //
  // Two layers refuse this and the test deliberately does not say which: the
  // trajectory adapter rejects a transcript with no normalizable user records,
  // and `captureExperience` independently checks that the normalized roles are
  // not all `meta`. Removing the service's own check leaves this case still
  // refused -- it is defence in depth against a dependency's validation, and
  // this test pins the guarantee rather than the guard that happens to fire.
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const { trajectory: _previousReference, ...metadata } = experience();
  const transcript = [
    { type: "session_meta", payload: { id: "session-empty", cwd: "/repo" } }
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

  await assert.rejects(
    service.captureExperience(
      {
        source: "codex",
        transcript,
        trajectoryUri: "file:///workspace/session.jsonl",
        experience: metadata
      },
      worker,
      { ...context, taskId: "task-old", runId: "run-old" }
    ),
    /did not contain any normalizable user records|no conversation records/u
  );
  assert.equal(
    repository.experiences.size,
    0,
    "nothing may be stored for a transcript with no conversation in it"
  );
});

test("captureExperience does not persist library-synthesized timestamps as source time", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const {
    trajectory: _trajectory,
    startedAt: _startedAt,
    completedAt: _completedAt,
    ...metadata
  } = experience();
  const transcript = [
    {
      type: "user",
      uuid: "user-record",
      sessionId: "session-a",
      cwd: "/workspace/repo",
      message: { role: "user", content: "private prompt" }
    },
    {
      type: "assistant",
      uuid: "assistant-record",
      sessionId: "session-a",
      message: { role: "assistant", content: "private response" }
    }
  ]
    .map((normalizedRecord) => JSON.stringify(normalizedRecord))
    .join("\n");

  const normalized = await service.captureExperience(
    {
      source: "claude-code",
      transcript,
      trajectoryUri: "file:///workspace/session.jsonl",
      experience: metadata
    },
    worker,
    { ...context, taskId: "task-old", runId: "run-old" }
  );

  const stored = repository.experiences.get(metadata.id);
  assert.equal(normalized.timestampsInferred, true);
  assert.equal(stored?.startedAt, "2026-09-30T10:00:00.000Z");
  assert.equal(stored?.completedAt, undefined);
  assert.equal(stored?.trajectory.sourceAdapter, "claude-code");
  assert.equal(stored?.trajectory.normalizerId, "@letta-ai/trajectory");
  assert.equal(
    stored?.trajectory.normalizerVersion,
    normalized.normalizerVersion
  );
  assert.deepEqual(
    stored?.trajectory.diagnosticCodes,
    normalized.diagnosticCodes
  );
  assert.ok(
    stored?.trajectory.diagnosticCodes?.some((code) =>
      code.startsWith("timestamps_")
    )
  );
  assert.doesNotMatch(
    JSON.stringify(stored),
    /private prompt|private response/u
  );
});

test("durable claims are redacted proposals with append-only provenance", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await service.appendExperience(experience(), worker, {
    ...context,
    taskId: "task-old",
    runId: "run-old"
  });

  const proposal = await service.propose(
    {
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-a"
      },
      claim:
        "Use API_KEY=super-secret-value only through the local credential store.",
      experienceIds: ["experience-1"],
      evidence: [source]
    },
    worker,
    context
  );

  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.validity.state, "unverified");
  assert.match(proposal.claim, /API_KEY=\[REDACTED\]/);
  assert.equal(repository.events[0]?.action, "proposed");
  await assert.rejects(
    service.propose(
      {
        kind: "semantic",
        scope: { kind: "global" },
        claim: "A claim with no source.",
        experienceIds: [],
        evidence: []
      },
      worker,
      context
    ),
    MemoryAuthorizationError
  );
});

test("durable candidates cannot cite missing or cross-workspace experience", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const proposal = {
    kind: "semantic" as const,
    scope: {
      kind: "repository" as const,
      workspaceId: "workspace-a",
      repositoryId: "repo-a"
    },
    claim: "A claim whose evidence must be visible.",
    experienceIds: ["missing-experience"],
    evidence: [source]
  };
  await assert.rejects(
    service.propose(proposal, worker, context),
    MemoryAuthorizationError
  );
  assert.equal(repository.memories.size, 0);

  const crossWorkspace = {
    ...experience("cross-workspace-experience"),
    workspaceId: "workspace-other",
    scope: { kind: "workspace" as const, workspaceId: "workspace-other" }
  };
  await repository.appendExperience(crossWorkspace);
  await assert.rejects(
    service.propose(
      { ...proposal, experienceIds: [crossWorkspace.id] },
      worker,
      context
    ),
    MemoryAuthorizationError
  );
  assert.equal(repository.memories.size, 0);
});

test("experience purging is curator-only and delegates a fingerprinted tombstone request", async () => {
  const repository = new FakeMemoryRepository();
  const rawExperience = experience("retention-exp");
  await repository.appendExperience(rawExperience);
  const service = makeService(repository, { makeId: () => "purge-event" });

  await assert.rejects(
    service.purgeExperience(
      "retention-exp",
      "privacy_request",
      worker,
      context
    ),
    MemoryAuthorizationError
  );
  assert.equal(repository.experiences.has("retention-exp"), true);

  assert.equal(
    await service.purgeExperience(
      "retention-exp",
      "retention_expired",
      root,
      context
    ),
    "purged"
  );
  assert.equal(repository.experiences.has("retention-exp"), false);
  assert.deepEqual(repository.purgeRequests, [
    {
      experienceId: "retention-exp",
      context,
      eventId: "purge-event",
      actorId: root.id,
      reason: "retention_expired",
      occurredAt: "2026-09-30T10:00:00.000Z"
    }
  ]);
});

test("experience purging preserves evidence referenced by durable memory", async () => {
  const repository = new FakeMemoryRepository();
  await repository.appendExperience(experience("experience-1"));
  const memory = record("preserved-provenance");
  repository.memories.set(memory.id, memory);
  const service = makeService(repository);

  assert.equal(
    await service.purgeExperience(
      "experience-1",
      "privacy_request",
      root,
      context
    ),
    "referenced_by_memory"
  );
  assert.equal(repository.experiences.has("experience-1"), true);
});

test("curator retention purges a bounded completed-history batch and skips referenced evidence", async () => {
  const repository = new FakeMemoryRepository();
  const expiredReferenced = {
    ...experience("expired-referenced"),
    completedAt: "2026-09-01T00:00:00.000Z"
  };
  const expiredUnreferenced = {
    ...experience("expired-unreferenced"),
    completedAt: "2026-09-02T00:00:00.000Z"
  };
  const recent = {
    ...experience("recent-run"),
    completedAt: "2026-09-29T00:00:00.000Z"
  };
  await repository.appendExperience(expiredReferenced);
  await repository.appendExperience(expiredUnreferenced);
  await repository.appendExperience(recent);
  repository.memories.set(
    "durable-reference",
    record("durable-reference", {
      provenance: {
        experienceIds: [expiredReferenced.id],
        evidence: [source],
        createdBy: root.id,
        createdAt: "2026-09-01T00:00:00.000Z"
      }
    })
  );
  const service = makeService(repository);
  const retentionContext = { ...context, canReadTaskHistory: true };

  await assert.rejects(
    service.purgeExpiredExperiences({
      completedBefore: "2026-09-15T00:00:00.000Z",
      limit: 10,
      actor: worker,
      context: retentionContext
    }),
    MemoryAuthorizationError
  );
  await assert.rejects(
    service.purgeExpiredExperiences({
      completedBefore: "2026-09-15T00:00:00.000Z",
      limit: 10,
      actor: root,
      context
    }),
    MemoryAuthorizationError
  );
  await assert.rejects(
    service.purgeExpiredExperiences({
      completedBefore: "2026-10-01T00:00:00.000Z",
      limit: 10,
      actor: root,
      context: retentionContext
    }),
    MemoryValidationError
  );
  await assert.rejects(
    service.purgeExpiredExperiences({
      completedBefore: "2026-09-15T00:00:00.000Z",
      limit: 101,
      actor: root,
      context: retentionContext
    }),
    MemoryValidationError
  );
  const report = await service.purgeExpiredExperiences({
    completedBefore: "2026-09-15T00:00:00.000Z",
    limit: 10,
    actor: root,
    context: retentionContext
  });

  assert.deepEqual(report, {
    selected: 1,
    purged: 1,
    referencedByMemory: 0,
    noLongerVisible: 0
  });
  assert.equal(repository.experiences.has(expiredReferenced.id), true);
  assert.equal(repository.experiences.has(expiredUnreferenced.id), false);
  assert.equal(repository.experiences.has(recent.id), true);
  assert.equal(repository.purgeRequests[0]?.reason, "retention_expired");
});

test("revisions create proposals and never rewrite the currently active claim", async () => {
  const repository = new FakeMemoryRepository();
  await repository.appendExperience(experience());
  const original = record("original");
  repository.memories.set(original.id, original);
  const service = makeService(repository);

  const revised = await service.revise(
    original.id,
    {
      claim: "Use the updated, focused validation command.",
      experienceIds: ["experience-1"],
      evidence: [source]
    },
    worker,
    context
  );

  assert.equal(revised.status, "proposed");
  assert.equal(repository.memories.get(original.id)?.claim, original.claim);
  assert.equal(repository.memories.get(original.id)?.status, "active");
  assert.equal(repository.events.at(-1)?.action, "revised");
  assert.deepEqual(repository.events.at(-1)?.relatedMemoryIds, [original.id]);
});

test("a worker may not propose memory into the global scope, even one that may read it", async () => {
  // `isMemoryScopeVisibleTo` answers `canReadGlobal` for a global scope, so a
  // worker permitted to *read* global memory passes the visibility arm outright.
  // The explicit `scope.kind === "global"` arm is then the only thing that can
  // refuse, which is why it exists separately.
  //
  // The global grant is what makes this a test of that arm. With the default
  // context the visibility arm refuses for a different reason, and the case
  // passes whether or not the global arm is there -- it asserts the guard, not
  // the branch, and a guard with a tested arm and an untested one reads, to a
  // mutation, as a guard.
  const service = makeService(new FakeMemoryRepository());
  const globalReader: MemoryReadContext = { ...context, canReadGlobal: true };

  await assert.rejects(
    service.propose(
      {
        kind: "semantic",
        scope: { kind: "global" },
        claim: "Every task should read the shared configuration first.",
        experienceIds: ["experience-1"],
        evidence: [source]
      },
      worker,
      globalReader
    ),
    /Workers may propose only memory scoped to their authorized/u
  );
});

/**
 * The graduation preconditions, each refused on its own terms.
 *
 * Promoting a procedure writes a canonical skill -- an artifact other agents
 * load by name. Every gate on that path was therefore load-bearing and every one
 * of them except the "successful, passing" run filter had no failing test: a
 * procedure that was never verified, that cited one run, that no longer matches
 * current state at the moment of promotion, or whose superseding replacement was
 * never verified, all reached the writer. Each case below therefore builds a
 * memory that satisfies *every other* precondition, so the one it asserts is the
 * only thing that can refuse it.
 */

const SKILL_INPUT = {
  name: "verified-memory-workflow",
  description: "A validated workflow.",
  content: "Re-check evidence and run focused tests."
} as const;

const SKILL_WRITER: MemorySkillPromotionWriter = {
  createSkill: async ({ name }) => ({
    name,
    path: `.rulesync/skills/${name}/SKILL.md`,
    uri: `rulesync://skills/${name}/SKILL.md`,
    revision: "c".repeat(64)
  })
};

/**
 * A procedural memory that satisfies every promotion precondition, plus the two
 * distinct successful runs it cites. `overrides` changes exactly one thing, and
 * `assessment` decides what the current-state check answers when it is asked.
 */
async function promotableProcedure(
  overrides: Partial<MemoryRecord> = {},
  options: { readonly assessment?: () => CurrentStateAssessment } = {}
): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
  readonly current: MemoryRecord;
}> {
  const repository = new FakeMemoryRepository();
  const current = record("procedure-candidate", {
    kind: "procedural",
    provenance: {
      experienceIds: ["success-run-a", "success-run-b"],
      evidence: [source],
      createdBy: root.id,
      createdAt: "2026-09-30T10:00:00.000Z"
    },
    ...overrides
  });
  repository.memories.set(current.id, current);
  for (const [id, taskId, runId] of [
    ["success-run-a", "task-a", "run-a"],
    ["success-run-b", "task-b", "run-b"]
  ] as const) {
    await repository.appendExperience({
      ...experience(id),
      taskId,
      runId,
      outcome: "success",
      validation: { state: "passed", evidence: [source] }
    });
  }
  return {
    repository,
    service: makeService(repository, {
      skillPromotionWriter: SKILL_WRITER,
      ...(options.assessment ? { assessment: options.assessment } : {})
    }),
    current
  };
}

test("a procedure that was never current-state-verified cannot graduate", async () => {
  const { service, current } = await promotableProcedure({
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /Only a current-state-verified procedural memory can be promoted\./u
  );
});

test("a procedure citing a single run cannot graduate", async () => {
  // Two *successful* runs exist in the repository, so this isolates the
  // citation count rather than the run quality the neighbouring case covers: a
  // record that names one experience has not earned two validated runs, however
  // good the run it names was.
  const { service, current } = await promotableProcedure({
    provenance: {
      experienceIds: ["success-run-a"],
      evidence: [source],
      createdBy: root.id,
      createdAt: "2026-09-30T10:00:00.000Z"
    }
  });

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /at least two validated successful runs/u
  );
});

test("a procedure that stopped matching current state cannot graduate", async () => {
  // The memory carries a verified verdict from whenever it was last checked.
  // Graduation happens later, against a repository that has moved since, so the
  // question has to be asked again at the moment of promotion -- otherwise the
  // stored verdict is trusted indefinitely and the check is decoration.
  const { service, current } = await promotableProcedure(
    {},
    {
      assessment: () => ({
        ...compatibleAssessment(),
        compatibility: "contradicted",
        reasonCode: "stale"
      })
    }
  );

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /verified against current state immediately before promotion/u
  );
});

test("a superseding replacement must itself be verified", async () => {
  // Supersession is how a corrected claim takes over from a wrong one, and it
  // activates the replacement. If the replacement went live unverified, the
  // correction would be the thing that introduces an unexamined active claim --
  // and it would do so over the record that was verified.
  const repository = new FakeMemoryRepository();
  const prior = record("prior");
  repository.memories.set(prior.id, prior);
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(replacement.id, replacement);
  const service = makeService(repository, {
    assessment: () => ({
      ...compatibleAssessment(),
      compatibility: "contradicted",
      reasonCode: "stale"
    })
  });

  await assert.rejects(
    service.supersede(replacement.id, prior.id, root, researchRequest()),
    /Replacement must be verified against current authoritative state\./u
  );
});

test("only a proposed memory may be promoted to active", async () => {
  // Promotion is what turns a proposal into guidance an agent will be handed.
  // Applying it to an already-active record would re-activate a claim that has
  // already been superseded, invalidated, or withdrawn.
  const repository = new FakeMemoryRepository();
  const active = record("already-active");
  repository.memories.set(active.id, active);
  const service = makeService(repository);

  await assert.rejects(
    service.verifyAndPromote(active.id, root, researchRequest()),
    /Only proposed memories can be promoted\./u
  );
  assert.equal(
    repository.memories.get(active.id)?.status,
    "active",
    "the refused record must be left exactly as it was"
  );
});

test("verified procedures promote to canonical skills only after two passed successful runs", async () => {
  const repository = new FakeMemoryRepository();
  const current = record("procedure-candidate", {
    kind: "procedural",
    provenance: {
      experienceIds: ["success-run-a", "success-run-b"],
      evidence: [source],
      createdBy: root.id,
      createdAt: "2026-09-30T10:00:00.000Z"
    }
  });
  repository.memories.set(current.id, current);
  for (const [id, taskId, runId] of [
    ["success-run-a", "task-a", "run-a"],
    ["success-run-b", "task-b", "run-b"]
  ] as const) {
    await repository.appendExperience({
      ...experience(id),
      taskId,
      runId,
      outcome: "success",
      validation: { state: "passed", evidence: [source] }
    });
  }
  let writes = 0;
  const service = makeService(repository, {
    skillPromotionWriter: {
      createSkill: async ({ name, description, content }) => {
        writes += 1;
        assert.equal(name, "verified-memory-workflow");
        assert.equal(description, "A validated workflow.");
        assert.match(content, /re-check evidence/i);
        return {
          name,
          path: `.rulesync/skills/${name}/SKILL.md`,
          uri: `rulesync://skills/${name}/SKILL.md`,
          revision: "a".repeat(64)
        };
      }
    }
  });
  const result = await service.promoteProcedureToSkill(
    current.id,
    {
      name: "verified-memory-workflow",
      description: "A validated workflow.",
      content: "Re-check evidence and run focused tests."
    },
    root,
    researchRequest()
  );
  assert.equal(result.memory.status, "invalidated");
  assert.equal(result.skill.name, "verified-memory-workflow");
  assert.equal(writes, 1);
  assert.equal(repository.events.at(-1)?.action, "procedure_promoted");
  assert.equal(repository.events.at(-1)?.reasonCode, "promoted_to_skill");
  assert.equal(
    repository.events
      .at(-1)
      ?.evidence.some(
        (item) => item.kind === "skill" && item.uri === result.skill.uri
      ),
    true
  );
  const repeated = await service.promoteProcedureToSkill(
    current.id,
    {
      name: "verified-memory-workflow",
      description: "A validated workflow.",
      content: "Re-check evidence and run focused tests."
    },
    root,
    researchRequest()
  );
  assert.equal(repeated.memory.status, "invalidated");
  assert.equal(
    repository.events.filter((event) => event.action === "procedure_promoted")
      .length,
    1,
    "repeating an identical promotion does not duplicate lifecycle history"
  );
  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      {
        name: "verified-memory-workflow",
        description: "A validated workflow.",
        content: "token=sk-123456789012345678901234"
      },
      root,
      researchRequest()
    ),
    MemoryValidationError
  );
});

test("a graduation decision reaches a real canonical skill on disk", async () => {
  // Every other promotion test substitutes a writer that fabricates its
  // artifact, so none of them proved the two halves meet: that the context the
  // service hands the writer still names a repository (the writer refuses
  // otherwise, which would make *every* real promotion fail), and that a
  // governance decision actually produces a version-controlled artifact.
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-graduation-")
  );
  try {
    const { repository, current } = await promotableProcedure();
    const graduating = makeService(repository, {
      skillPromotionWriter: new RuleSyncMemorySkillPromoter({
        resolve: () => repositoryRoot
      })
    });

    const result = await graduating.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    );

    assert.equal(result.memory.status, "invalidated");
    assert.equal(result.skill.revision.length, 64);
    assert.ok(
      (
        await readFile(path.join(repositoryRoot, result.skill.path), "utf8")
      ).includes(SKILL_INPUT.content),
      "the promoted procedure is canonical on disk, not a stub artifact"
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("skill promotion rejects procedures without sufficient validation and never writes", async () => {
  const repository = new FakeMemoryRepository();
  const current = record("unproven-procedure", {
    kind: "procedural",
    provenance: {
      experienceIds: ["success-run-a"],
      evidence: [source],
      createdBy: root.id,
      createdAt: "2026-09-30T10:00:00.000Z"
    }
  });
  repository.memories.set(current.id, current);
  await repository.appendExperience(experience("success-run-a"));
  let writes = 0;
  const service = makeService(repository, {
    skillPromotionWriter: {
      createSkill: async () => {
        writes += 1;
        throw new Error("must not write unproven content");
      }
    }
  });
  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      {
        name: "unproven-procedure",
        description: "Not enough evidence.",
        content: "Do the procedure."
      },
      root,
      researchRequest()
    ),
    MemoryValidationError
  );
  assert.equal(writes, 0);
  assert.equal(repository.memories.get(current.id)?.status, "active");
});

test("workers cannot publish or invalidate shared durable knowledge", async () => {
  const repository = new FakeMemoryRepository();
  const proposed = record("proposed", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(proposed.id, proposed);
  const service = makeService(repository);

  await assert.rejects(
    service.verifyAndPromote(proposed.id, worker, researchRequest()),
    MemoryAuthorizationError
  );
  await assert.rejects(
    service.invalidate(proposed.id, worker, context, [source]),
    MemoryAuthorizationError
  );
});

test("promotion requires current-state evidence and uncertain claims remain excluded", async () => {
  const repository = new FakeMemoryRepository();
  const proposed = record("candidate", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(proposed.id, proposed);
  const service = makeService(repository, {
    assessment: () => ({
      ...compatibleAssessment(),
      compatibility: "unknown",
      evidence: [],
      reasonCode: "verification_inconclusive"
    })
  });

  const uncertain = await service.verifyAndPromote(
    proposed.id,
    root,
    researchRequest()
  );
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.validity.state, "uncertain");
  assert.equal(repository.events.at(-1)?.toStatus, "uncertain");

  repository.hits = [
    { memory: uncertain, score: 1, matchedSignals: ["lexical"] }
  ];
  const packet = await service.research(researchRequest());
  assert.equal(packet.entries.length, 0);
  assert.equal(packet.text, "");
});

test("every write path that publishes an active claim also verifies it", async () => {
  // The Console's "Active Claims" card renders the Runtime's `statusCounts`
  // rollup — a `GROUP BY status` over the whole filtered collection — under the
  // subtitle "Verified & in service". That subtitle is a claim about
  // `validity.state`, which is a different field from the `status` the rollup
  // groups by. Nothing on the Console side can check it: it is true only if
  // every write path keeps the two paired, and nothing asserted that.
  //
  // Swept over the repository rather than asserted field by field, so a path
  // added later that publishes an active record without verifying it fails
  // here instead of silently turning a status count into a claim that the
  // claims are true.
  const repository = new FakeMemoryRepository();
  // Swept after each path, not once at the end. A single sweep at the end
  // looks equivalent and is not: superseding the promoted record demotes it to
  // `superseded`, so the record the promote path produced is no longer `active`
  // by the time the sweep runs, and a promote path that published an active but
  // unverified claim would pass. Checked once the status is set is the only
  // moment the invariant is observable for that path.
  const assertEveryActiveClaimIsVerified = (when: string): void => {
    const unverifiedButActive = [...repository.memories.values()]
      .filter((memory) => memory.status === "active")
      .filter((memory) => memory.validity.state !== "verified")
      .map((memory) => `${memory.id}:${memory.status}/${memory.validity.state}`);
    assert.deepEqual(
      unverifiedButActive,
      [],
      `${when}: a record published as active must carry verified validity`
    );
  };
  const proposed = record("candidate", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(proposed.id, proposed);
  const service = makeService(repository);

  const promoted = await service.verifyAndPromote(
    proposed.id,
    root,
    researchRequest()
  );
  assert.equal(promoted.status, "active");
  assertEveryActiveClaimIsVerified("after promote");

  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(replacement.id, replacement);
  const superseding = await service.supersede(
    replacement.id,
    promoted.id,
    root,
    researchRequest()
  );
  assert.equal(superseding.status, "active");
  assertEveryActiveClaimIsVerified("after supersede");
});

test("research validates current state, filters scope and lifecycle, and injects only cited guidance", async () => {
  const repository = new FakeMemoryRepository();
  const applicable = record("applicable");
  const wrongScope = record("wrong-scope", {
    scope: {
      kind: "repository",
      workspaceId: "workspace-b",
      repositoryId: "repo-b"
    }
  });
  const expired = record("expired", {
    validity: {
      state: "verified",
      validTo: "2026-09-30T09:00:00.000Z",
      evidence: [source]
    }
  });
  const notVerified = record("not-verified", {
    validity: { state: "uncertain", evidence: [] }
  });
  const superseded = record("superseded", { status: "superseded" });
  repository.hits = [
    applicable,
    wrongScope,
    expired,
    notVerified,
    superseded
  ].map((memory) => ({
    memory,
    score: 1,
    matchedSignals: ["lexical"]
  }));
  const service = makeService(repository);

  const packet = await service.research(researchRequest());

  assert.deepEqual(
    packet.entries.map((entry) => entry.memoryId),
    ["applicable"]
  );
  assert.match(packet.text, /Current state confirms/);
  assert.match(packet.text, /git:\/\/workspace-a\/repo-a\/commit\/abc123/);
  assert.equal(packet.characterCount, packet.text.length);
});

test("search and research exclude exactly the same ineligible memories", async () => {
  // These two public reads used to decide eligibility from two separate
  // statements of the same rule: `search` filtered through a boolean helper,
  // `research` refused through `rejectionReason`. Two copies drift silently --
  // removing any single condition from the boolean helper changed nothing
  // observable, because the other copy masked it, so the whole helper could
  // have been wrong with the suite green. `search` had no eligibility test at
  // all; its only coverage was input validation.
  //
  // So this asserts the *agreement* rather than restating the table twice: one
  // fixture set, both reads, both expected to keep the single eligible record.
  // A future rule added to one path and not the other fails here by
  // construction, which is the property the duplication could not express.
  const repository = new FakeMemoryRepository();
  const applicable = record("applicable");

  const provenance = record("applicable").provenance;
  const validity = { state: "verified" as const, evidence: [source] };
  const ineligible: MemoryRecord[] = [
    record("wrong-scope", {
      scope: {
        kind: "repository",
        workspaceId: "workspace-b",
        repositoryId: "repo-b"
      }
    }),
    record("superseded", { status: "superseded" }),
    record("invalidated", { status: "invalidated" }),
    // Statuses that are not `active` are refused even when the validity state
    // is `verified` -- the two fields are separate and both are checked.
    record("proposed", { status: "proposed" }),
    record("unverified", { validity: { state: "unverified", evidence: [] } }),
    record("contradicted", {
      validity: { state: "contradicted", evidence: [] }
    }),
    // The validity window is half-open: [validFrom, validTo). An instant that is
    // exactly `validFrom` is inside it; an instant at `validTo` is not.
    record("not-yet-valid", {
      validity: { ...validity, validFrom: "2099-01-01T00:00:00.000Z" }
    }),
    record("expired", {
      validity: { ...validity, validTo: "2026-09-30T09:00:00.000Z" }
    }),
    record("no-experience", {
      provenance: { ...provenance, experienceIds: [] }
    }),
    record("no-evidence", { provenance: { ...provenance, evidence: [] } })
  ];

  // Typed explicitly rather than mapped inline: inside the array literal the
  // spread defeats the contextual type, and `matchedSignals` widens to
  // `string[]`, which is not the signal union.
  const ineligibleHits: MemorySearchHit[] = ineligible.map((memory) => ({
    memory,
    score: 1,
    matchedSignals: ["lexical"]
  }));
  repository.hits = [
    { memory: applicable, score: 1, matchedSignals: ["lexical"] },
    // A hit whose score cannot rank it. `research` already refused these as
    // `low_relevance`; `search` did not, and would have sorted them in.
    {
      memory: record("unrankable"),
      score: Number.NaN,
      matchedSignals: ["lexical"]
    },
    ...ineligibleHits
  ];
  const service = makeService(repository);

  const searched = await service.search({
    query: "memory repository implementation",
    context,
    limit: 40
  });
  const packet = await service.research(researchRequest());

  assert.deepEqual(
    searched.map((hit) => hit.memory.id),
    ["applicable"]
  );
  assert.deepEqual(
    packet.entries.map((entry) => entry.memoryId),
    ["applicable"]
  );
});

test("memory search and research reject empty or oversized task-kind signals", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await assert.rejects(
    service.search({ query: "configuration", context, taskKind: " " }),
    MemoryValidationError
  );
  await assert.rejects(
    service.research(researchRequest({ taskKind: "bugfix".repeat(34) })),
    MemoryValidationError
  );
  assert.equal(repository.searchRequests.length, 0);
});

test("MemoryService emits bounded candidate, packet, and operation metrics", async () => {
  const repository = new FakeMemoryRepository();
  const selected = record("metric-selected");
  repository.memories.set(selected.id, selected);
  const stale = record("metric-stale", {
    validity: {
      state: "verified",
      validTo: "2026-09-29T00:00:00.000Z",
      checkedAt: "2026-09-15T12:00:00.000Z",
      evidence: [source]
    }
  });
  repository.hits = [
    { memory: selected, score: 1, matchedSignals: ["lexical"] },
    { memory: stale, score: 0.9, matchedSignals: ["lexical"] }
  ];
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000
  });
  const provider = new MeterProvider({ readers: [reader] });
  const service = makeService(repository, {
    meter: provider.getMeter("autodev.memory.test"),
    countTokens: () => 17
  });

  try {
    const packet = await service.research(researchRequest());
    assert.equal(packet.entries.length, 1);
    await service.invalidate(selected.id, root, context, [source]);
    await provider.forceFlush();

    const metrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    const byName = new Map(
      metrics.map((metric) => [metric.descriptor.name, metric])
    );
    const candidateMetric = byName.get("autodev.memory.candidates");
    assert.ok(candidateMetric);
    const candidatePoints = candidateMetric.dataPoints;
    const point = (stage: string, reason?: string) =>
      candidatePoints.find(
        (item) =>
          item.attributes["autodev.memory.candidate.stage"] === stage &&
          (reason === undefined ||
            item.attributes["autodev.memory.reason"] === reason)
      );
    assert.equal(point("retrieved")?.value, 2);
    assert.equal(point("retained")?.value, 1);
    assert.equal(point("rejected", "stale")?.value, 1);
    assert.equal(point("packet_included")?.value, 1);
    const allowedDimensions = new Set([
      "autodev.memory.candidate.stage",
      "autodev.memory.kind",
      "autodev.memory.reason"
    ]);
    const allowedStages = new Set([
      "retrieved",
      "retained",
      "revised",
      "rejected",
      "packet_included",
      "packet_omitted"
    ]);
    for (const item of candidatePoints) {
      for (const [key, value] of Object.entries(item.attributes)) {
        assert.ok(allowedDimensions.has(key));
        assert.equal(typeof value, "string");
      }
      assert.ok(
        allowedStages.has(
          String(item.attributes["autodev.memory.candidate.stage"])
        )
      );
    }

    const packetCharacters = byName.get("autodev.memory.packet.characters");
    const packetTokens = byName.get("autodev.memory.packet.tokens");
    const characterPoint = packetCharacters?.dataPoints[0];
    const tokenPoint = packetTokens?.dataPoints[0];
    const characterAggregation = characterPoint?.value;
    const tokenAggregation = tokenPoint?.value;
    assert.ok(
      characterAggregation &&
        typeof characterAggregation === "object" &&
        "sum" in characterAggregation
    );
    assert.ok(characterAggregation.sum > 0);
    assert.ok(
      tokenAggregation &&
        typeof tokenAggregation === "object" &&
        "sum" in tokenAggregation
    );
    assert.equal(tokenAggregation.sum, 17);
    assert.ok(byName.has("autodev.memory.operation.duration"));
    const operations = byName.get("autodev.memory.operations");
    assert.ok(operations);
    assert.equal(
      operations.dataPoints.find(
        (item) =>
          item.attributes["autodev.memory.operation"] === "memory.invalidate" &&
          item.attributes["autodev.memory.outcome"] === "success"
      )?.value,
      1
    );
  } finally {
    await provider.shutdown();
  }
});

test("MemoryService counts a newly appended outcome report with bounded span attributes", async () => {
  const repository = new FakeMemoryRepository();
  const spanAttributes = new Map<string, unknown>();
  const tracer = {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      return callback({
        setAttribute: (key: string, value: unknown) => {
          if (name === "memory.outcome.report") spanAttributes.set(key, value);
        },
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
  const { exporter, provider, service } = makeOutcomeMetricHarness(
    repository,
    tracer
  );
  repository.outcomeReportResults.push({
    appended: true,
    id: "private-outcome-report-id"
  });

  try {
    await persistOutcomeInjection(repository, service);
    const result = await service.recordOutcomeReport({
      report: outcomeReport(),
      actor: root,
      context
    });
    assert.equal(result.appended, true);
    await provider.forceFlush();

    const points = outcomeReportMetricPoints(exporter);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, 1);
    assert.deepEqual(points[0]?.attributes, {
      "autodev.memory.outcome.report_kind": "task",
      "autodev.memory.outcome.kind": "success",
      "autodev.memory.outcome.memory_mode": "jit",
      "autodev.memory.outcome.injection_result": "injected"
    });
    assert.deepEqual([...spanAttributes.keys()].sort(), [
      "memory.outcome.injection_result",
      "memory.outcome.kind",
      "memory.outcome.memory_mode",
      "memory.outcome.report_kind"
    ]);
    assert.deepEqual([...spanAttributes.values()].sort(), [
      "injected",
      "jit",
      "success",
      "task"
    ]);
  } finally {
    await provider.shutdown();
  }
});

test("MemoryService does not recount an idempotent outcome-report retry", async () => {
  const repository = new FakeMemoryRepository();
  const { exporter, provider, service } = makeOutcomeMetricHarness(repository);
  repository.outcomeReportResults.push(
    { appended: true, id: "private-outcome-report-id" },
    { appended: false, id: "private-outcome-report-id" }
  );

  try {
    await persistOutcomeInjection(repository, service);
    const input = { report: outcomeReport(), actor: root, context };
    assert.equal((await service.recordOutcomeReport(input)).appended, true);
    assert.equal((await service.recordOutcomeReport(input)).appended, false);
    await provider.forceFlush();

    const points = outcomeReportMetricPoints(exporter);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, 1);
  } finally {
    await provider.shutdown();
  }
});

test("outcome cohort dimensions come from the persisted injection event", async () => {
  const repository = new FakeMemoryRepository();
  const { exporter, provider, service } = makeOutcomeMetricHarness(repository);
  const event = outcomeInjectionEvent({
    memoryMode: "disabled",
    injectionResult: "skipped"
  });
  repository.outcomeReportResults.push({
    appended: true,
    id: "private-outcome-report-id"
  });

  try {
    await persistOutcomeInjection(repository, service, event);
    await service.recordOutcomeReport({
      report: outcomeReport({
        outcomeKind: "partial",
        reportKind: "issue"
      }),
      actor: root,
      context
    });
    await provider.forceFlush();

    const points = outcomeReportMetricPoints(exporter);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, 1);
    assert.deepEqual(points[0]?.attributes, {
      "autodev.memory.outcome.report_kind": "issue",
      "autodev.memory.outcome.kind": "partial",
      "autodev.memory.outcome.memory_mode": "disabled",
      "autodev.memory.outcome.injection_result": "skipped"
    });
  } finally {
    await provider.shutdown();
  }
});

test("outcome-report metric dimensions exclude IDs and evidence URIs", async () => {
  const repository = new FakeMemoryRepository();
  const { exporter, provider, service } = makeOutcomeMetricHarness(repository);
  repository.outcomeReportResults.push({
    appended: true,
    id: "private-outcome-report-id"
  });

  try {
    await persistOutcomeInjection(repository, service);
    await service.recordOutcomeReport({
      report: outcomeReport(),
      actor: root,
      context
    });
    await provider.forceFlush();

    const points = outcomeReportMetricPoints(exporter);
    assert.equal(points.length, 1);
    const attributes = points[0]!.attributes;
    assert.deepEqual(Object.keys(attributes).sort(), [
      "autodev.memory.outcome.injection_result",
      "autodev.memory.outcome.kind",
      "autodev.memory.outcome.memory_mode",
      "autodev.memory.outcome.report_kind"
    ]);
    const serializedDimensions = JSON.stringify(attributes);
    for (const sensitiveValue of [
      "private-injection-id",
      "private-injection-run-id",
      "private-injection-agent-id",
      "private-correlation-token",
      "private-memory-id",
      "private-recorder-id",
      "private-outcome-report-id",
      "private-report-run-id",
      "private-report-agent-id",
      "private-reporter-id",
      "private-injection-evidence",
      "private-report-evidence"
    ]) {
      assert.equal(serializedDimensions.includes(sensitiveValue), false);
    }
  } finally {
    await provider.shutdown();
  }
});

test("MemoryService records session outcome reports and exports metrics", async () => {
  const repository = new FakeMemoryRepository();
  const { exporter, provider, service } = makeOutcomeMetricHarness(repository);

  try {
    const report = sessionOutcomeReportHelper();
    const result = await service.recordSessionOutcomeReport({
      report,
      actor: root,
      context
    });
    assert.equal(result.appended, true);
    await provider.forceFlush();

    const points = sessionOutcomeReportMetricPoints(exporter);
    assert.equal(points.length, 1);
    assert.equal(points[0]?.value, 1);
    assert.deepEqual(points[0]?.attributes, {
      "autodev.memory.session_outcome.report_kind": "task",
      "autodev.memory.session_outcome.kind": "success"
    });

    // Idempotent retry does not recount
    const retry = await service.recordSessionOutcomeReport({
      report,
      actor: root,
      context
    });
    assert.equal(retry.appended, false);
    await provider.forceFlush();
    assert.equal(sessionOutcomeReportMetricPoints(exporter).length, 1);
  } finally {
    await provider.shutdown();
  }
});

test("MemoryService enforces actor authority and evidence for session outcome reports", async () => {
  const repository = new FakeMemoryRepository();
  const { provider, service } = makeOutcomeMetricHarness(repository);

  try {
    // Worker authority rejected
    await assert.rejects(
      async () => {
        await service.recordSessionOutcomeReport({
          report: sessionOutcomeReportHelper(),
          actor: worker,
          context
        });
      },
      { message: /root or memory curator/i }
    );

    // Missing evidence for non-unknown outcome rejected
    await assert.rejects(
      async () => {
        await service.recordSessionOutcomeReport({
          report: sessionOutcomeReportHelper({ evidence: [] }),
          actor: root,
          context
        });
      },
      { message: /evidence reference/i }
    );
  } finally {
    await provider.shutdown();
  }
});

test("MemoryService getSessionOutcomeReport retrieves report and enforces scope", async () => {
  const repository = new FakeMemoryRepository();
  const { provider, service } = makeOutcomeMetricHarness(repository);

  try {
    const report = sessionOutcomeReportHelper();
    await service.recordSessionOutcomeReport({
      report,
      actor: root,
      context
    });

    const fetched = await service.getSessionOutcomeReport(
      report.workspaceId,
      report.repositoryId,
      report.taskId,
      context
    );
    assert.notEqual(fetched, null);
    assert.equal(fetched?.id, report.id);

    // Mismatched workspace rejected
    await assert.rejects(
      async () => {
        await service.getSessionOutcomeReport(
          "other-ws",
          report.repositoryId,
          report.taskId,
          context
        );
      },
      { message: /Workspace mismatch/i }
    );
  } finally {
    await provider.shutdown();
  }
});

test("packet bounds use whole entries and enforce a supplied token counter", async () => {
  const repository = new FakeMemoryRepository();
  repository.hits = [record("long", { claim: "A long but valid claim." })].map(
    (memory) => ({
      memory,
      score: 1,
      matchedSignals: ["lexical"]
    })
  );
  const service = makeService(repository, {
    countTokens: (text) => text.length
  });

  const packet = await service.research(
    researchRequest({ maxPacketCharacters: 32, maxPacketTokens: 32 })
  );
  assert.equal(packet.entries.length, 0);
  assert.equal(packet.omittedCount, 1);
  assert.equal(packet.characterCount, 0);
  assert.equal(packet.tokenCount, 0);
  await assert.rejects(
    makeService(repository).research(researchRequest({ maxPacketTokens: 1 })),
    MemoryValidationError
  );
});

test("supersession updates both records and appends both events atomically", async () => {
  const repository = new FakeMemoryRepository();
  const old = record("old");
  const replacement = record("new", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(old.id, old);
  repository.memories.set(replacement.id, replacement);
  let eventId = 0;
  const service = makeService(repository, {
    makeId: () => `event-${++eventId}`
  });

  const active = await service.supersede(
    replacement.id,
    old.id,
    root,
    researchRequest()
  );
  assert.equal(active.status, "active");
  assert.deepEqual(active.supersedes, ["old"]);
  assert.equal(repository.memories.get(old.id)?.status, "superseded");
  assert.deepEqual(repository.memories.get(old.id)?.supersededBy, ["new"]);
  assert.equal(repository.events.length, 2);

  repository.failNextTransition = true;
  const otherPrior = record("old-2");
  const otherReplacement = record("new-2", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] }
  });
  repository.memories.set(otherPrior.id, otherPrior);
  repository.memories.set(otherReplacement.id, otherReplacement);
  await assert.rejects(
    service.supersede(
      otherReplacement.id,
      otherPrior.id,
      root,
      researchRequest()
    ),
    MemoryConflictError
  );
  assert.equal(repository.memories.get(otherPrior.id)?.status, "active");
  assert.equal(
    repository.memories.get(otherReplacement.id)?.status,
    "proposed"
  );
});

test("invalidation is soft lifecycle state and keeps event evidence", async () => {
  const repository = new FakeMemoryRepository();
  const active = record("active");
  repository.memories.set(active.id, active);
  const service = makeService(repository);

  const invalidated = await service.invalidate(active.id, root, context, [
    source
  ]);
  assert.equal(invalidated.status, "invalidated");
  assert.equal(repository.memories.has(active.id), true);
  assert.equal(repository.events.at(-1)?.action, "invalidated");
  assert.deepEqual(repository.events.at(-1)?.evidence, [source]);
});

test("evidence locators remove credentials before persistence or injection", () => {
  const sanitized = sanitizeEvidenceReference({
    kind: "document",
    uri: "https://user:password@example.test/memory?token=secret&ref=main#fragment"
  });
  assert.equal(sanitized.uri, "https://example.test/memory?ref=main");
  assert.doesNotMatch(sanitized.uri, /password|secret|fragment/);
});

/**
 * The test above proves the helper works. It cannot prove anything arrives at
 * the repository sanitized -- the helper is called on every write path whether
 * or not the call survives, and a test that only invokes it stays green when
 * the call is deleted. Deleting `sanitizeEvidence` from `propose`,
 * `appendExperience` and `recordInjectionEvent` each left this file fully
 * green, which left "secrets and unnecessary sensitive payloads are not
 * persisted by default" -- an acceptance criterion in the memory spec, not an
 * implementation detail -- unenforced on the evidence path. Claim redaction
 * and the canonical-skill refusal were both pinned; these three were not.
 *
 * So the assertion is on what crosses into the repository, never on the
 * helper. The markers are deliberately distinctive: `hunter2` and
 * `tok-LIVE-9f3a` appear nowhere else in the fixtures, so any surviving
 * occurrence in a stored row is a leak by definition and cannot be confused
 * with unrelated content.
 */
const CREDENTIALED_URI =
  "https://deploy:hunter2@ci.example.test/memory?token=tok-LIVE-9f3a&ref=main#frag";
const SANITIZED_URI = "https://ci.example.test/memory?ref=main";

function credentialedEvidence(): EvidenceReference {
  return { kind: "document", uri: CREDENTIALED_URI };
}

function assertNothingCredentialReachedStorage(stored: unknown): void {
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(
    serialized,
    /hunter2/u,
    "a basic-auth password reached storage"
  );
  assert.doesNotMatch(serialized, /tok-LIVE-9f3a/u, "an access token reached storage");
}

test("an experience's credentialed evidence and trajectory are sanitized before storage", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await service.appendExperience(
    {
      ...experience(),
      // The trajectory locator is sanitized on a separate path from the
      // evidence array, so it carries its own credentials: dropping either
      // sanitization leaves one of the two markers behind.
      trajectory: {
        ...experience().trajectory,
        uri: "https://deploy:hunter2@ci.example.test/trajectory.jsonl?token=tok-LIVE-9f3a"
      },
      evidence: [credentialedEvidence()]
    },
    worker,
    { ...context, taskId: "task-old", runId: "run-old" }
  );

  const stored = repository.experiences.get("experience-1");
  assert.ok(stored, "the experience should have been stored");
  assertNothingCredentialReachedStorage(stored);
  assert.equal(stored.evidence[0]?.uri, SANITIZED_URI);
});

test("a proposed memory's credentialed evidence is sanitized before storage", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await service.appendExperience(experience(), worker, {
    ...context,
    taskId: "task-old",
    runId: "run-old"
  });

  const proposal = await service.propose(
    {
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-a"
      },
      claim: "The CI deploy target is configured by the release job.",
      experienceIds: ["experience-1"],
      evidence: [credentialedEvidence()]
    },
    worker,
    context
  );

  const stored = repository.memories.get(proposal.id);
  assert.ok(stored, "the proposal should have been stored");
  assertNothingCredentialReachedStorage(stored);
  assert.equal(stored.provenance.evidence[0]?.uri, SANITIZED_URI);
});

test("a recorded injection event's credentialed evidence is sanitized before storage", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const event = outcomeInjectionEvent({ evidence: [credentialedEvidence()] });

  await service.recordInjectionEvent({
    event,
    actor: root,
    context: {
      ...context,
      taskId: event.taskId,
      runId: event.runId,
      agentId: event.agentId
    }
  });

  const stored = repository.injectionEvents.get(event.correlationToken);
  assert.ok(stored, "the injection event should have been stored");
  assertNothingCredentialReachedStorage(stored);
  assert.equal(stored.evidence[0]?.uri, SANITIZED_URI);
});

test("embedding vectors are optional retrieval signals and never become record content", async () => {
  const repository = new FakeMemoryRepository();
  const embedded = makeService(repository, {
    embedder: { embed: async () => [0.25, -0.5, 0.75] }
  });
  await embedded.appendExperience(experience(), worker, {
    ...context,
    taskId: "task-old",
    runId: "run-old"
  });
  const candidate = await embedded.propose(
    {
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-a"
      },
      claim: "Use structured query parameters for database filters.",
      experienceIds: ["experience-1"],
      evidence: [source]
    },
    worker,
    context
  );
  assert.equal(candidate.claim.includes("0.25"), false);
  assert.deepEqual(repository.proposalEmbeddings[0], [0.25, -0.5, 0.75]);

  repository.hits = [record("embedded")].map((memory) => ({
    memory,
    score: 1,
    matchedSignals: ["semantic"]
  }));
  await embedded.research(researchRequest());
  assert.deepEqual(
    repository.searchRequests.at(-1)?.queryEmbedding,
    [0.25, -0.5, 0.75]
  );
  await assert.rejects(
    makeService(repository, {
      embedder: { embed: async () => [Number.NaN] }
    }).research(researchRequest()),
    MemoryValidationError
  );
});

test("unavailable optional embeddings fall back to lexical memory operations", async () => {
  const repository = new FakeMemoryRepository();
  const embeddingSpanAttributes: Map<string, unknown>[] = [];
  const tracer = {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      const attributes = new Map<string, unknown>();
      if (name === "memory.embed") embeddingSpanAttributes.push(attributes);
      return callback({
        setAttribute: (key: string, value: unknown) =>
          attributes.set(key, value),
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
  await repository.appendExperience(experience());
  const service = makeService(repository, {
    embedder: {
      embed: async () => {
        throw new MemoryEmbeddingUnavailableError();
      }
    },
    tracer
  });

  await service.propose(
    {
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "workspace-a",
        repositoryId: "repo-a"
      },
      claim: "Keep lexical retrieval available during provider outages.",
      experienceIds: ["experience-1"],
      evidence: [source]
    },
    worker,
    context
  );
  assert.equal(repository.proposalEmbeddings.at(-1), undefined);

  const recalled = record("lexical-fallback");
  repository.hits = [
    { memory: recalled, score: 1, matchedSignals: ["lexical"] }
  ];
  const packet = await service.research(researchRequest());
  assert.deepEqual(
    packet.entries.map((entry) => entry.memoryId),
    [recalled.id]
  );
  assert.equal(repository.searchRequests.at(-1)?.queryEmbedding, undefined);
  assert.ok(
    embeddingSpanAttributes.some(
      (attributes) => attributes.get("memory.embedding.fallback") === "lexical"
    )
  );
});

test("JIT spans expose bounded stage/count attributes and not task text", async () => {
  const repository = new FakeMemoryRepository();
  repository.hits = [record("trace-test")].map((memory) => ({
    memory,
    score: 1,
    matchedSignals: ["lexical"]
  }));
  const spanNames: string[] = [];
  const attributeNames: string[] = [];
  const tracer = {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      spanNames.push(name);
      const span = {
        setAttribute: (attribute: string) => attributeNames.push(attribute),
        setStatus: () => undefined,
        end: () => undefined
      };
      return callback(span as never);
    }
  } as unknown as Tracer;
  await makeService(repository, { tracer }).research(researchRequest());

  for (const stage of [
    "memory.research",
    "memory.query",
    "memory.retrieve",
    "memory.rerank",
    "memory.validate",
    "memory.reconstruct",
    "memory.packet"
  ]) {
    assert.ok(spanNames.includes(stage), `${stage} must be instrumented`);
  }
  assert.ok(attributeNames.includes("memory.candidates.retrieved"));
  assert.ok(attributeNames.includes("memory.packet.characters"));
  assert.equal(attributeNames.includes("task"), false);
  assert.equal(attributeNames.includes("query"), false);
});

test("official MCP facade exposes governed tools and binds scope outside model arguments", async () => {
  const repository = new FakeMemoryRepository();
  await repository.appendExperience(experience());
  const visible = record("visible");
  repository.memories.set(visible.id, visible);
  repository.hits = [visible].map((memory) => ({
    memory,
    score: 1,
    matchedSignals: ["lexical"]
  }));
  const service = makeService(repository);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMemoryMcpServer(service, {
    current: async () => ({
      actor: worker,
      context,
      taskId: "task-current",
      task: "Investigate memory MCP scope safety.",
      memoryMode: "unknown"
    })
  });
  const client = new Client(
    { name: "memory-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "experience_append",
      "experience_get",
      "experience_search",
      "memory_get",
      "memory_history",
      "memory_invalidate",
      "memory_propose",
      "memory_research",
      "memory_revise",
      "memory_search",
      "memory_why"
    ]);

    const appendArguments = {
      workspaceId: "attacker-selected-workspace",
      taskId: "attacker-selected-task",
      agentId: "attacker-selected-agent",
      trajectory: {
        format: "claude-code-native-jsonl",
        uri: "https://example.invalid/session/transcript.jsonl?token=do-not-persist",
        digest: "A".repeat(64),
        recordCount: 12
      },
      startedAt: "2026-09-30T10:00:00.000Z",
      completedAt: "2026-09-30T10:05:00.000Z",
      outcome: "success",
      validation: {
        state: "passed",
        evidence: [
          {
            kind: "pull_request",
            uri: "https://example.invalid/repo/pull/12?token=validation-secret"
          }
        ]
      },
      evidence: [
        {
          kind: "file",
          uri: "https://example.invalid/repo/src/feature.ts?token=evidence-secret"
        }
      ]
    };
    const firstAppend = await client.callTool({
      name: "experience_append",
      arguments: appendArguments
    });
    assert.equal(firstAppend.isError, undefined);
    const firstAppendText = (firstAppend.content as Array<{ text?: string }>)[0]
      ?.text;
    const firstAppendResult = JSON.parse(firstAppendText ?? "null") as {
      id: string;
      appended: boolean;
    };
    assert.equal(firstAppendResult.appended, true);
    const appendedExperience = repository.experiences.get(firstAppendResult.id);
    assert.ok(appendedExperience);
    assert.deepEqual(appendedExperience.scope, {
      kind: "agent",
      workspaceId: "workspace-a",
      taskId: "task-current",
      runId: "run-current",
      agentId: "agent-current"
    });
    assert.equal(
      appendedExperience.trajectory.uri,
      "https://example.invalid/session/transcript.jsonl"
    );
    assert.equal(appendedExperience.trajectory.digest, "a".repeat(64));
    assert.equal(
      appendedExperience.validation?.evidence[0]?.uri,
      "https://example.invalid/repo/pull/12"
    );
    assert.doesNotMatch(
      JSON.stringify(appendedExperience),
      /attacker-selected|do-not-persist|validation-secret|evidence-secret/
    );
    const repeatedAppend = await client.callTool({
      name: "experience_append",
      arguments: {
        ...appendArguments,
        trajectory: { ...appendArguments.trajectory, digest: "a".repeat(64) }
      }
    });
    const repeatedAppendText = (
      repeatedAppend.content as Array<{ text?: string }>
    )[0]?.text;
    assert.deepEqual(JSON.parse(repeatedAppendText ?? "null"), {
      id: firstAppendResult.id,
      appended: false
    });

    const [unboundClientTransport, unboundServerTransport] =
      InMemoryTransport.createLinkedPair();
    const unboundServer = createMemoryMcpServer(service, {
      current: () => ({
        actor: worker,
        context: { ...context, taskId: "different-host-task" },
        taskId: "task-current",
        task: "Unbound MCP task",
        memoryMode: "unknown"
      })
    });
    const unboundClient = new Client(
      { name: "unbound-memory-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await unboundServer.connect(unboundServerTransport);
    await unboundClient.connect(unboundClientTransport);
    try {
      const unboundAppend = await unboundClient.callTool({
        name: "experience_append",
        arguments: appendArguments
      });
      assert.equal(unboundAppend.isError, true);
      assert.equal(repository.experiences.size, 2);
    } finally {
      await unboundClient.close();
      await unboundServer.close();
    }

    const result = await client.callTool({
      name: "memory_research",
      arguments: {
        query: "memory service",
        taskKind: "bugfix",
        workspaceId: "attacker-selected-workspace"
      }
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      repository.searchRequests.at(-1)?.context.workspaceId,
      "workspace-a"
    );
    assert.equal(
      repository.searchRequests.at(-1)?.context.taskId,
      "task-current"
    );
    assert.equal(repository.searchRequests.at(-1)?.taskKind, "bugfix");
    const responseContent = result.content as Array<{
      type: string;
      text?: string;
    }>;
    const responseText = responseContent[0];
    assert.ok(responseText?.type === "text");
    const packet = JSON.parse(responseText.text ?? "null") as MemoryPacket;
    assert.equal(packet.taskId, "task-current");

    const scopeDenial = await client.callTool({
      name: "memory_propose",
      arguments: {
        kind: "semantic",
        scope: {
          kind: "workspace",
          workspaceId: "attacker-selected-workspace"
        },
        claim: "Try to publish into a different workspace.",
        experienceIds: ["experience-1"],
        evidence: [source]
      }
    });
    assert.equal(scopeDenial.isError, true);
    assert.equal(repository.memories.has("generated-1"), false);

    const denial = await client.callTool({
      name: "memory_invalidate",
      arguments: { id: "visible", evidence: [source] }
    });
    assert.equal(denial.isError, true);
    assert.equal(repository.memories.get("visible")?.status, "active");
  } finally {
    await client.close();
    await server.close();
  }
});

test("memory MCP tool arguments stay strict: smuggled keys fail at every schema level", async () => {
  const repository = new FakeMemoryRepository();
  await repository.appendExperience(experience());
  const service = makeService(repository);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMemoryMcpServer(service, {
    current: async () => ({
      actor: worker,
      context,
      taskId: "task-current",
      task: "Verify tool arguments stay strict.",
      memoryMode: "unknown"
    })
  });
  const client = new Client(
    { name: "strict-memory-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const validAppend = {
    startedAt: "2026-09-30T10:00:00.000Z",
    completedAt: "2026-09-30T10:05:00.000Z",
    outcome: "success",
    trajectory: {
      format: "claude-code-native-jsonl",
      uri: "https://example.invalid/session/transcript.jsonl",
      digest: "a".repeat(64),
      recordCount: 12
    },
    validation: { state: "passed", evidence: [] },
    evidence: [
      { kind: "file", uri: "https://example.invalid/repo/src/feature.ts" }
    ]
  };

  try {
    const experiencesBefore = repository.experiences.size;
    const memoriesBefore = repository.memories.size;

    // Baseline: the same payload without smuggled keys is accepted, so every
    // rejection below is attributable to the unknown key and nothing else.
    // Without `z.strictObject` these inputs would be stripped and accepted.
    //
    // The cases below cover the nested schemas this repo owns. The outermost
    // tool `inputSchema` is a bare shape object the MCP SDK wraps in its own
    // `z.object` (strip semantics), so top-level unknown keys are ignored by
    // the SDK rather than rejected here — harmless, because the handler
    // rebinds workspace/task/run/agent/role from the host session anyway.
    const accepted = await client.callTool({
      name: "experience_append",
      arguments: validAppend
    });
    assert.equal(accepted.isError, undefined);
    assert.equal(repository.experiences.size, experiencesBefore + 1);

    const smuggled: ReadonlyArray<{
      readonly level: string;
      readonly arguments: Record<string, unknown>;
    }> = [
      {
        level: "trajectory",
        arguments: {
          ...validAppend,
          trajectory: {
            ...validAppend.trajectory,
            workspaceId: "attacker-selected-workspace"
          }
        }
      },
      {
        level: "validation",
        arguments: {
          ...validAppend,
          validation: {
            ...validAppend.validation,
            role: "attacker-selected-role"
          }
        }
      },
      {
        level: "an evidence reference",
        arguments: {
          ...validAppend,
          evidence: [{ ...validAppend.evidence[0], scope: { kind: "global" } }]
        }
      }
    ];

    for (const { level, arguments: smuggledArguments } of smuggled) {
      const rejected = await client.callTool({
        name: "experience_append",
        arguments: smuggledArguments
      });
      assert.equal(
        rejected.isError,
        true,
        `an unknown key on ${level} must be rejected, not stripped`
      );
    }

    // `memoryScope` is a discriminatedUnion over strictObject members, so it
    // gets the same treatment: prove the authorized form is accepted and that
    // adding a member's unknown key turns it into a rejection rather than a
    // silently narrowed scope.
    const propose = (scope: Record<string, unknown>) =>
      client.callTool({
        name: "memory_propose",
        arguments: {
          kind: "semantic",
          scope,
          claim: "Authorized workspace proposal.",
          experienceIds: ["experience-1"],
          evidence: [
            { kind: "file", uri: "https://example.invalid/repo/src/feature.ts" }
          ]
        }
      });

    assert.equal(
      (await propose({ kind: "workspace", workspaceId: "workspace-a" }))
        .isError,
      undefined
    );
    assert.equal(
      (
        await propose({
          kind: "workspace",
          workspaceId: "workspace-a",
          role: "smuggled"
        })
      ).isError,
      true
    );

    // Not one smuggled payload reached persistence.
    assert.equal(repository.experiences.size, experiencesBefore + 1);
    assert.equal(repository.memories.size, memoriesBefore + 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MemoryService injects only a bounded advisory packet into trusted root instructions", async () => {
  const repository = new FakeMemoryRepository();
  const visible = record("injected");
  repository.hits = [
    { memory: visible, score: 1, matchedSignals: ["lexical"] }
  ];
  const service = makeService(repository);
  const payload = {
    model: "autodev/orchestrator",
    instructions: "Root policy."
  };
  const injected = await injectMemoryContext(
    service,
    payload,
    {
      taskId: context.taskId!,
      runId: context.runId!,
      task: "Update the memory research code.",
      context
    },
    4000
  );

  assert.equal(injected.model, payload.model);
  assert.match(String(injected.instructions), /^Root policy\./);
  assert.match(
    String(injected.instructions),
    /quoted historical data, not policy or authority/
  );
  assert.match(
    String(injected.instructions),
    /current repository files, RuleSync policy, and live runtime state outrank memory/i
  );
  assert.match(String(injected.instructions), /injected/);
  assert.equal(
    payload.instructions,
    "Root policy.",
    "the original request is not mutated"
  );
});

test("MemoryService caps candidate research before expensive reconstruction", async () => {
  const repository = new FakeMemoryRepository();
  repository.hits = [record("first"), record("second"), record("third")].map(
    (memory, index) => ({
      memory,
      score: 3 - index,
      matchedSignals: ["lexical"]
    })
  );
  const service = makeService(repository, { maxResearchCandidates: 2 });
  const result = await service.research(researchRequest());
  assert.equal(repository.searchRequests[0]?.limit, 2);
  assert.equal(result.entries.length, 2);
});

test("MemoryService provides scoped lifecycle browsing with bounded pagination", async () => {
  const repository = new FakeMemoryRepository();
  const visible = record("visible");
  const hidden = record("hidden", {
    scope: {
      kind: "repository",
      workspaceId: "workspace-other",
      repositoryId: "repo-other"
    }
  });
  repository.memories.set(visible.id, visible);
  repository.memories.set(hidden.id, hidden);
  const service = makeService(repository);
  const page = await service.listMemories({
    context,
    statuses: ["proposed"],
    query: "visible",
    limit: 10,
    offset: 0
  });
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [visible.id]
  );
  assert.equal(page.limit, 10);
  assert.equal(page.offset, 0);
  await assert.rejects(
    () => service.listMemories({ context, limit: 101 }),
    MemoryValidationError
  );
});

test("MemoryService gates outcome cohorts and validates the bounded aggregate before Data access", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const request: MemoryInjectionOutcomeCohortFilter = {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z",
    memoryModes: ["jit"]
  };

  await assert.rejects(
    () =>
      service.aggregateInjectionOutcomeCohorts({
        ...request,
        context: { ...request.context, canReadTaskHistory: false }
      }),
    MemoryAuthorizationError
  );
  assert.equal(repository.outcomeCohortRequests.length, 0);

  const page = await service.aggregateInjectionOutcomeCohorts(request);
  assert.equal(page.schema, "autodev-memory-injection-outcome-cohorts-v1");
  assert.equal(page.workspaceId, request.context.workspaceId);
  assert.equal(page.repositoryId, request.context.repositoryId);
  assert.deepEqual(repository.outcomeCohortRequests, [request]);

  await assert.rejects(
    () =>
      service.aggregateInjectionOutcomeCohorts({
        ...request,
        occurredFrom: "2024-01-01T00:00:00.000Z"
      }),
    TypeError
  );
  assert.equal(repository.outcomeCohortRequests.length, 1);
});

test("MemoryService traces aggregate cohort counts without query identities", async () => {
  const repository = new FakeMemoryRepository();
  const attributes = new Map<string, unknown>();
  const spanNames: string[] = [];
  const tracer = {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      spanNames.push(name);
      return callback({
        setAttribute: (key: string, value: unknown) =>
          attributes.set(key, value),
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
  const service = makeService(repository, { tracer });

  await service.aggregateInjectionOutcomeCohorts({
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  });

  assert.deepEqual(spanNames, ["memory.injection.outcome.aggregate"]);
  assert.deepEqual(Object.fromEntries(attributes), {
    "memory.injection.outcome.exposures": 0,
    "memory.injection.outcome.reports": 0,
    "memory.injection.outcome.cohort_cells": 0
  });
  assert.doesNotMatch(
    [...attributes.keys()].join(" "),
    /workspace|repository|task|run|agent|memory_id/u
  );
});

test("MemoryService enforces task-history access and validates session cohort filters", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const request: MemorySessionOutcomeCohortFilter = {
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z",
    memoryModes: ["jit"]
  };

  await assert.rejects(
    () =>
      service.aggregateSessionOutcomeCohorts({
        ...request,
        context: { ...request.context, canReadTaskHistory: false }
      }),
    MemoryAuthorizationError
  );
  assert.equal(repository.sessionOutcomeCohortRequests.length, 0);

  const page = await service.aggregateSessionOutcomeCohorts(request);
  assert.equal(page.schema, "autodev-memory-session-outcome-cohorts-v1");
  assert.equal(page.workspaceId, request.context.workspaceId);
  assert.equal(page.repositoryId, request.context.repositoryId);
  assert.deepEqual(repository.sessionOutcomeCohortRequests, [request]);

  await assert.rejects(
    () =>
      service.aggregateSessionOutcomeCohorts({
        ...request,
        occurredFrom: "2024-01-01T00:00:00.000Z"
      }),
    TypeError
  );
  assert.equal(repository.sessionOutcomeCohortRequests.length, 1);
});

test("MemoryService traces aggregate session cohort counts without query identities", async () => {
  const repository = new FakeMemoryRepository();
  const attributes = new Map<string, unknown>();
  const spanNames: string[] = [];
  const tracer = {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      spanNames.push(name);
      return callback({
        setAttribute: (key: string, value: unknown) =>
          attributes.set(key, value),
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
  const service = makeService(repository, { tracer });

  await service.aggregateSessionOutcomeCohorts({
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      canReadGlobal: false,
      canReadTaskHistory: true
    },
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  });

  assert.deepEqual(spanNames, ["memory.session.outcome.aggregate"]);
  assert.deepEqual(Object.fromEntries(attributes), {
    "memory.session.outcome.sessions": 0,
    "memory.session.outcome.reported_sessions": 0,
    "memory.session.outcome.unreported_sessions": 0,
    "memory.session.outcome.conflicting_sessions": 0,
    "memory.session.outcome.mixed_mode_sessions": 0,
    "memory.session.outcome.cohort_cells": 0
  });
  assert.doesNotMatch(
    [...attributes.keys()].join(" "),
    /workspace|repository|task|run|agent|memory_id/u
  );
});

function useInjectionEvent(
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  return outcomeInjectionEvent({
    memoryIds: ["mem-use-1", "mem-use-2"],
    packetCharacterCount: 64,
    packetTokenCount: 16,
    taskId: "task-old",
    runId: "run-old",
    agentId: worker.id,
    ...overrides
  });
}

test("MemoryService recordInjectionUseReport enforces root/curator authority and task-history grant", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  await persistOutcomeInjection(repository, service, useInjectionEvent());

  // Worker authority rejected
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: "private-injection-id",
      useKind: "used",
      usedMemoryIds: ["mem-use-1", "mem-use-2"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: worker,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /root or memory curator/i }
  );

  // Missing canReadTaskHistory rejected
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: "private-injection-id",
      useKind: "used",
      usedMemoryIds: ["mem-use-1", "mem-use-2"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context
    }),
    { message: /task-history access/i }
  );

  // Missing repository scope rejected
  const noRepoContext: MemoryReadContext = {
    workspaceId: context.workspaceId,
    canReadGlobal: context.canReadGlobal,
    canReadTaskHistory: true
  };
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: "private-injection-id",
      useKind: "used",
      usedMemoryIds: ["mem-use-1", "mem-use-2"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: noRepoContext
    }),
    { message: /repository scope/i }
  );
});

test("MemoryService recordInjectionUseReport anchors trajectory evidence to the captured experience trajectory", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  await persistOutcomeInjection(repository, service, useInjectionEvent());

  // Trajectory URI mismatch rejected
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: "private-injection-id",
      useKind: "used",
      usedMemoryIds: ["mem-use-1", "mem-use-2"],
      evidence: [
        { kind: "trajectory", uri: "file:///some/other/trajectory.jsonl" }
      ],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /trajectory/i }
  );

  // Non-trajectory evidence for non-unobservable rejected
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: "private-injection-id",
      useKind: "not_used",
      usedMemoryIds: [],
      evidence: [
        { kind: "commit", uri: "git://workspace-a/repo-a/commit/abc123" }
      ],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /captured trajectory/i }
  );

  // OK with matching trajectory URI
  const result = await service.recordInjectionUseReport({
    experienceId: env.id,
    injectionEventId: "private-injection-id",
    useKind: "used",
    usedMemoryIds: ["mem-use-1", "mem-use-2"],
    evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true }
  });
  assert.equal(result.appended, true);
});

test("MemoryService recordInjectionUseReport validates usedMemoryIds subset/cardinality per useKind", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  const event = useInjectionEvent();
  await persistOutcomeInjection(repository, service, event);

  // used must cite every injected id
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: event.id,
      useKind: "used",
      usedMemoryIds: ["mem-use-1"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /every injected memory id/i }
  );

  // partially_used must be a non-empty strict subset
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: event.id,
      useKind: "partially_used",
      usedMemoryIds: [...event.memoryIds],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /strict subset/i }
  );

  // not_used must not cite any memory id
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: event.id,
      useKind: "not_used",
      usedMemoryIds: ["mem-use-1"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /must not cite any memory id/i }
  );

  // subset violation
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: event.id,
      useKind: "partially_used",
      usedMemoryIds: ["not-in-packet"],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /subset of the injected memoryIds/i }
  );
});

test("MemoryService recordInjectionUseReport only records on eligible injected event", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });

  // Empty packet rejected
  const empty = useInjectionEvent({
    id: "private-empty-id",
    correlationToken: "private-empty-token",
    injectionResult: "empty",
    memoryIds: [],
    packetCharacterCount: 0,
    packetTokenCount: 0,
    reasonCode: "no_packet_research_returned_empty"
  });
  await persistOutcomeInjection(repository, service, empty);
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: empty.id,
      useKind: "used",
      usedMemoryIds: [],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /eligible injected event/i }
  );

  // Disabled mode rejected
  const disabled = useInjectionEvent({
    id: "private-disabled-id",
    correlationToken: "private-disabled-token",
    memoryMode: "disabled"
  });
  await persistOutcomeInjection(repository, service, disabled);
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: disabled.id,
      useKind: "used",
      usedMemoryIds: [...disabled.memoryIds],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /eligible injected event/i }
  );

  // Unrelated task id rejected
  const unrelated = useInjectionEvent({
    id: "private-unrelated-id",
    correlationToken: "private-unrelated-token",
    taskId: "task-other"
  });
  await persistOutcomeInjection(repository, service, unrelated);
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: unrelated.id,
      useKind: "used",
      usedMemoryIds: [...unrelated.memoryIds],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    { message: /targets an event outside the captured session/i }
  );
});

test("MemoryService recordInjectionUseReport returns idempotent retry and conflict for conflicting retry", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  const event = useInjectionEvent();
  await persistOutcomeInjection(repository, service, event);

  const first = await service.recordInjectionUseReport({
    experienceId: env.id,
    injectionEventId: event.id,
    useKind: "partially_used",
    usedMemoryIds: ["mem-use-1"],
    evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true }
  });
  assert.equal(first.appended, true);

  // Idempotent retry returns appended:false with same id
  const retry = await service.recordInjectionUseReport({
    experienceId: env.id,
    injectionEventId: event.id,
    useKind: "partially_used",
    usedMemoryIds: ["mem-use-1"],
    evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true }
  });
  assert.deepEqual(retry, { appended: false, id: first.id });

  // Conflicting retry throws MemoryConflictError
  await assert.rejects(
    service.recordInjectionUseReport({
      experienceId: env.id,
      injectionEventId: event.id,
      useKind: "used",
      usedMemoryIds: [...event.memoryIds],
      evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
      actor: root,
      context: { ...context, canReadTaskHistory: true }
    }),
    MemoryConflictError
  );
});

test("MemoryService listInjectionUseJoins is gated by task-history access and projects only safe fields", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  const event = useInjectionEvent();
  await persistOutcomeInjection(repository, service, event);

  await service.recordInjectionUseReport({
    experienceId: env.id,
    injectionEventId: event.id,
    useKind: "partially_used",
    usedMemoryIds: ["mem-use-1"],
    evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true }
  });

  // Without task-history, list rejected
  await assert.rejects(
    service.listInjectionUseJoins({
      context: { ...context, canReadTaskHistory: false }
    }),
    { message: /task-history/i }
  );

  const sessionContext = {
    ...context,
    canReadTaskHistory: true,
    taskId: env.taskId,
    runId: env.runId,
    agentId: env.agentId
  };
  const page = await service.listInjectionUseJoins({
    context: sessionContext
  });
  assert.equal(page.total, 1);
  const item = page.items[0];
  assert.ok(item);
  assert.ok(item.use);
  assert.equal(item.use?.useKind, "partially_used");
  // raw event includes correlationToken; the Control API layer is responsible
  // for projecting only safe fields onto the response payload.
  assert.equal(typeof item.injection.correlationToken, "string");
});

test("MemoryService aggregateInjectionUseCohorts counts assessed and unassessed exposures without identities", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const env = experience();
  await service.appendExperience(env, worker, {
    ...context,
    taskId: env.taskId,
    runId: env.runId
  });
  const reported = useInjectionEvent({ id: "event-reported" });
  const pending = useInjectionEvent({
    id: "event-pending",
    correlationToken: "token-pending",
    runId: "private-injection-run-id-2",
    agentId: "private-injection-agent-id-2"
  });
  await persistOutcomeInjection(repository, service, reported);
  await persistOutcomeInjection(repository, service, pending);

  await service.recordInjectionUseReport({
    experienceId: env.id,
    injectionEventId: reported.id,
    useKind: "partially_used",
    usedMemoryIds: ["mem-use-1"],
    evidence: [{ kind: "trajectory", uri: env.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true }
  });

  const aggregateContext: MemoryReadContext = {
    workspaceId: context.workspaceId,
    ...(context.repositoryId ? { repositoryId: context.repositoryId } : {}),
    canReadGlobal: false,
    canReadTaskHistory: true
  };
  const page = await service.aggregateInjectionUseCohorts({
    context: aggregateContext,
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  });
  assert.equal(page.exposureCount, 2);
  assert.ok(page.cells.some((cell) => cell.useKind === null));
  assert.ok(page.cells.some((cell) => cell.useKind === "partially_used"));
  // No cell leaks correlation tokens, reporter IDs, or usedMemoryIds
  for (const cell of page.cells) {
    assert.equal("correlationToken" in cell, false);
    assert.equal("reporterId" in cell, false);
    assert.equal("usedMemoryIds" in cell, false);
  }
});

/**
 * The session-scoped injection/outcome join behind the Console's "Injection
 * events and reported outcomes" panel. Its filters are claims about stored
 * rows: each must either match the stored vocabulary or be refused, because an
 * unmatchable filter answered with an empty page reads as "nothing exists".
 */
function outcomeJoinRequest(
  overrides: Partial<MemoryInjectionOutcomeJoinRequest> = {}
): MemoryInjectionOutcomeJoinRequest {
  return {
    context: { ...context, canReadTaskHistory: true },
    ...overrides
  };
}

async function reportedOutcomeJoin(): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
}> {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await persistOutcomeInjection(repository, service);
  await service.recordOutcomeReport({
    report: outcomeReport(),
    actor: root,
    context: context
  });
  return { repository, service };
}

test("the injection/outcome join refuses a reader without task history instead of returning nothing", async () => {
  const { repository, service } = await reportedOutcomeJoin();

  await assert.rejects(
    service.listInjectionOutcomeJoins({
      context: { ...context, canReadTaskHistory: false }
    }),
    MemoryAuthorizationError
  );

  // The refusal has to happen at the boundary. Answering from the post-read
  // visibility filter instead would report an empty page for a session that
  // does have rows, and `total` would still carry the repository's count.
  assert.equal(repository.outcomeJoinRequests.length, 0);
});

test("the injection/outcome join refuses a memory mode outside the vocabulary", async () => {
  const { repository, service } = await reportedOutcomeJoin();

  // One bogus entry sits well inside the five-member bound, which is why this
  // read once forwarded it to storage and came back empty.
  await assert.rejects(
    service.listInjectionOutcomeJoins(
      outcomeJoinRequest({
        memoryModes: ["not-a-mode"] as unknown as MemoryExecutionMode[]
      })
    ),
    MemoryValidationError
  );
  assert.equal(repository.outcomeJoinRequests.length, 0);
});

test("the injection/outcome join refuses a memory mode list longer than the vocabulary", async () => {
  const { service } = await reportedOutcomeJoin();

  // Six entries, every one of them a valid mode, so the vocabulary check
  // cannot be what refuses this: only the bound can. Without it the duplicate
  // list is forwarded and expands into six bind parameters for one mode.
  await assert.rejects(
    service.listInjectionOutcomeJoins(
      outcomeJoinRequest({
        memoryModes: Array.from(
          { length: 6 },
          () => "jit"
        ) as unknown as MemoryExecutionMode[]
      })
    ),
    MemoryValidationError
  );
});

test("the injection/outcome join refuses an injection result and a report kind outside the vocabularies", async () => {
  const { repository, service } = await reportedOutcomeJoin();

  await assert.rejects(
    service.listInjectionOutcomeJoins(
      outcomeJoinRequest({
        injectionResults: [
          "not-a-result"
        ] as unknown as MemoryInjectionResult[]
      })
    ),
    MemoryValidationError
  );
  await assert.rejects(
    service.listInjectionOutcomeJoins(
      outcomeJoinRequest({
        reportKinds: ["not-a-kind"] as unknown as MemoryOutcomeReportKind[]
      })
    ),
    MemoryValidationError
  );
  assert.equal(repository.outcomeJoinRequests.length, 0);
});

test("the injection/outcome join refuses an outcome kind outside the vocabulary", async () => {
  const { repository, service } = await reportedOutcomeJoin();

  // The Control API builds `outcomeKinds` from EXPERIENCE_OUTCOMES, but the
  // service never checked the field it was actually handed.
  await assert.rejects(
    service.listInjectionOutcomeJoins(
      outcomeJoinRequest({
        outcomeKinds: ["not-an-outcome"] as unknown as ExperienceOutcome[]
      })
    ),
    MemoryValidationError
  );
  assert.equal(repository.outcomeJoinRequests.length, 0);
});

test("the injection/outcome join accepts every stored vocabulary and returns the reported row", async () => {
  const { repository, service } = await reportedOutcomeJoin();

  const page = await service.listInjectionOutcomeJoins(
    outcomeJoinRequest({
      memoryModes: ["jit"],
      injectionResults: ["injected"],
      outcomeKinds: ["success"],
      reportKinds: ["task"]
    })
  );

  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.outcome?.outcomeKind, "success");
  assert.equal(page.items[0]?.injection.correlationToken, "private-correlation-token");
  assert.equal(repository.outcomeJoinRequests.length, 1);
});

test("includeUnreported surfaces a stored injection that has no outcome yet", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await persistOutcomeInjection(repository, service);

  const reportedOnly = await service.listInjectionOutcomeJoins(
    outcomeJoinRequest()
  );
  assert.equal(reportedOnly.total, 0);

  const unreported = await service.listInjectionOutcomeJoins(
    outcomeJoinRequest({ includeUnreported: true })
  );
  assert.equal(unreported.total, 1);
  assert.equal(unreported.items[0]?.outcome, null);
});

test("the injection/outcome join keys on the session and ignores request-level run and agent identity", async () => {
  const { service } = await reportedOutcomeJoin();

  // The stored event keeps the request-level runId/agentId the reporter context
  // does not carry; comparing them would hide every row of a real session.
  const page = await service.listInjectionOutcomeJoins(outcomeJoinRequest());

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.injection.runId, "private-injection-run-id");
  assert.equal(page.items[0]?.injection.agentId, "private-injection-agent-id");
});

test("a row belonging to another session never appears in the join", async () => {
  const { repository, service } = await reportedOutcomeJoin();
  repository.injectionEvents.set(
    "foreign-token",
    outcomeInjectionEvent({
      id: "foreign-injection-id",
      correlationToken: "foreign-token",
      taskId: "task-other",
      runId: "run-other",
      agentId: "agent-other"
    })
  );

  const page = await service.listInjectionOutcomeJoins(outcomeJoinRequest());

  // Enforced here by the repository's session scope, which the service passes
  // down in its own context. The service re-checks the row after the read so a
  // repository that returned more than it was asked for still cannot leak it;
  // that re-check is not what this assertion exercises.
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.injection.correlationToken, "private-correlation-token");
});

test("an outcome recorded against another session is dropped from the join", async () => {
  const { repository, service } = await reportedOutcomeJoin();
  // Same correlation token, so the join attaches it; the session is not the
  // reporter's. The repository's scope filter covers the event, not the
  // outcome joined onto it, so this is the service's own visibility check.
  repository.outcomeReports.set(
    "private-correlation-token",
    outcomeReport({
      id: "foreign-outcome-report-id",
      taskId: "task-other"
    })
  );

  const page = await service.listInjectionOutcomeJoins(outcomeJoinRequest());

  assert.equal(page.items.length, 0);
});

/**
 * The two experience list reads the Console's experiences table depends on,
 * and the scope key that decides which memory may supersede which. Both were
 * reachable from production and covered by no service-level test: the
 * repository double ignored every request, so the service's own validation,
 * pagination clamping and post-read visibility filter never ran.
 */
function experienceSearchRequest(
  overrides: Partial<ExperienceSearchRequest> = {}
): ExperienceSearchRequest {
  return { query: "memory repository", context, ...overrides };
}

test("experience search refuses an empty or unbounded query", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.searchExperiences(experienceSearchRequest({ query: "   " })),
    MemoryValidationError
  );
  await assert.rejects(
    service.searchExperiences(
      experienceSearchRequest({ query: "x".repeat(4001) })
    ),
    MemoryValidationError
  );
  assert.equal(repository.experienceSearchRequests.length, 0);
});

test("experience search bounds the hit count it asks storage for and returns", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  for (let index = 0; index < 45; index += 1)
    repository.experiences.set(`experience-${index}`, experience(`experience-${index}`));

  const page = await service.searchExperiences(
    experienceSearchRequest({ limit: 1000 })
  );

  // Forty is the cap; a caller asking for a thousand must not widen the query
  // storage runs, nor the payload it sends back.
  assert.equal(repository.experienceSearchRequests[0]?.limit, 40);
  assert.equal(page.length, 40);

  const defaulted = await service.searchExperiences(experienceSearchRequest());
  assert.equal(repository.experienceSearchRequests[1]?.limit, 10);
  assert.equal(defaulted.length, 45 > 10 ? 10 : 45);
});

test("experience search hides another run's raw trajectory from an ordinary reader", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  repository.experiences.set(
    "run-private",
    experience("run-private")
  );
  const runPrivate = repository.experiences.get("run-private")!;
  repository.experiences.set("run-private", {
    ...runPrivate,
    scope: { kind: "task", workspaceId: "workspace-a", taskId: "task-old", runId: "run-old" },
    taskId: "task-old",
    runId: "run-old"
  });

  const ordinary = await service.searchExperiences(experienceSearchRequest());
  assert.equal(ordinary.length, 0);

  // Only the explicit curator grant reaches another run's trajectory.
  const curator = await service.searchExperiences(
    experienceSearchRequest({
      context: { ...context, canReadTaskHistory: true }
    })
  );
  assert.equal(curator.length, 1);
  assert.equal(curator[0]?.id, "run-private");
});

test("experience search hides a repository the reader cannot see", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const foreign = experience("foreign-repo");
  repository.experiences.set("foreign-repo", {
    ...foreign,
    repositoryId: "repo-b",
    scope: { kind: "repository", workspaceId: "workspace-a", repositoryId: "repo-b" }
  });

  const page = await service.searchExperiences(experienceSearchRequest());
  assert.equal(page.length, 0);
});

test("the experience list refuses filters and page bounds it cannot honour", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.listExperiences({
      context,
      memoryModes: ["not-a-mode"] as unknown as MemoryExecutionMode[]
    }),
    MemoryValidationError
  );
  await assert.rejects(
    service.listExperiences({
      context,
      outcomes: ["not-an-outcome"] as unknown as ExperienceOutcome[]
    }),
    MemoryValidationError
  );
  await assert.rejects(
    service.listExperiences({ context, limit: 101 }),
    MemoryValidationError
  );
  await assert.rejects(
    service.listExperiences({ context, offset: -1 }),
    MemoryValidationError
  );
  assert.equal(repository.experienceListRequests.length, 0);
});

test("the experience list reports the pagination it applied and hides invisible rows", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const visible = experience("visible");
  repository.experiences.set("visible", visible);
  const foreign = experience("foreign-repo");
  repository.experiences.set("foreign-repo", {
    ...foreign,
    repositoryId: "repo-b",
    scope: { kind: "repository", workspaceId: "workspace-a", repositoryId: "repo-b" }
  });

  const page = await service.listExperiences({ context });

  // The service owns the page bounds it reports, not the ones storage echoes.
  assert.equal(page.limit, 50);
  assert.equal(page.offset, 0);
  assert.equal(repository.experienceListRequests[0]?.limit, 50);
  assert.deepEqual(
    page.items.map((item) => item.id),
    ["visible"]
  );

  const paged = await service.listExperiences({ context, limit: 25, offset: 10 });
  assert.equal(paged.limit, 25);
  assert.equal(paged.offset, 10);
  assert.equal(repository.experienceListRequests[1]?.offset, 10);
});

test("a task-scoped memory cannot supersede an agent-scoped one", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  // Both are visible to this context, so the scope key is the only thing that
  // can refuse the pair.
  const prior = record("prior", {
    scope: {
      kind: "task",
      workspaceId: "workspace-a",
      taskId: "task-current",
      runId: "run-current"
    }
  });
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope: {
      kind: "agent",
      workspaceId: "workspace-a",
      taskId: "task-current",
      runId: "run-current",
      agentId: "agent-current"
    }
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  await assert.rejects(
    service.supersede(replacement.id, prior.id, root, researchRequest()),
    /same kind and exact scope/u
  );
  assert.equal(repository.memories.get(prior.id)?.status, "active");
});

test("a workspace-wide role memory cannot supersede a repository-scoped role memory", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  // Both are visible: a role scope with no repository is visible from anywhere
  // in the workspace. Only the exact scope differs.
  const prior = record("prior", {
    scope: { kind: "role", workspaceId: "workspace-a", role: "worker" }
  });
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope: {
      kind: "role",
      workspaceId: "workspace-a",
      role: "worker",
      repositoryId: "repo-a"
    }
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  await assert.rejects(
    service.supersede(replacement.id, prior.id, root, researchRequest()),
    /same kind and exact scope/u
  );
});

test("two memories in the exact same role scope do supersede", async () => {
  const repository = new FakeMemoryRepository();
  let eventId = 0;
  const service = makeService(repository, {
    makeId: () => `event-${++eventId}`
  });
  const scope = {
    kind: "role" as const,
    workspaceId: "workspace-a",
    role: "worker"
  };
  const prior = record("prior", { scope });
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  const active = await service.supersede(
    replacement.id,
    prior.id,
    root,
    researchRequest()
  );

  assert.equal(active.status, "active");
  assert.equal(repository.memories.get(prior.id)?.status, "superseded");
});

test("a global-scoped memory supersedes only under an explicit global grant", async () => {
  const repository = new FakeMemoryRepository();
  let eventId = 0;
  const service = makeService(repository, {
    makeId: () => `event-${++eventId}`
  });
  const globalScope = { kind: "global" as const };
  const prior = record("prior", { scope: globalScope });
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope: globalScope
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  // A missing global grant is not implied by absent scope metadata.
  await assert.rejects(
    service.supersede(replacement.id, prior.id, root, researchRequest()),
    /must be visible to supersede/u
  );

  const active = await service.supersede(
    replacement.id,
    prior.id,
    root,
    researchRequest({ context: { ...context, canReadGlobal: true } })
  );
  assert.equal(active.status, "active");
});

test("a global-scoped memory cannot supersede a repository-scoped one", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const prior = record("prior");
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope: { kind: "global" }
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  await assert.rejects(
    service.supersede(
      replacement.id,
      prior.id,
      root,
      researchRequest({ context: { ...context, canReadGlobal: true } })
    ),
    /same kind and exact scope/u
  );
});

test("a workspace-scoped memory supersedes another workspace-scoped one", async () => {
  const repository = new FakeMemoryRepository();
  let eventId = 0;
  const service = makeService(repository, {
    makeId: () => `event-${++eventId}`
  });
  const workspaceScope = { kind: "workspace" as const, workspaceId: "workspace-a" };
  const prior = record("prior", { scope: workspaceScope });
  const replacement = record("replacement", {
    status: "proposed",
    validity: { state: "unverified", evidence: [] },
    scope: workspaceScope
  });
  repository.memories.set(prior.id, prior);
  repository.memories.set(replacement.id, replacement);

  const active = await service.supersede(
    replacement.id,
    prior.id,
    root,
    researchRequest()
  );

  assert.equal(active.status, "active");
  assert.equal(repository.memories.get(prior.id)?.status, "superseded");
});

/**
 * The write path that produces every reported outcome, and therefore the whole
 * basis of the injection/outcome evaluation. Each guard here decides whether a
 * reporter's claim reaches storage at all.
 */
async function outcomeReportHarness(): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
}> {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await persistOutcomeInjection(repository, service);
  return { repository, service };
}

test("only root or curator authorities may record an outcome, and the actor supplies the recorded authority", async () => {
  const { repository, service } = await outcomeReportHarness();

  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport(),
      actor: worker,
      context
    }),
    MemoryAuthorizationError
  );
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport(),
      actor: { id: "system-agent", authority: "system" },
      context
    }),
    MemoryAuthorizationError
  );
  assert.equal(repository.outcomeReports.size, 0);

  // `outcomeReport()` claims reporterAuthority "worker"; the stored value must
  // come from the authenticated actor instead.
  await service.recordOutcomeReport({
    report: outcomeReport(),
    actor: root,
    context
  });
  assert.equal(
    repository.outcomeReports.get("private-correlation-token")?.reporterAuthority,
    "root"
  );
});

test("an outcome report outside the trusted session scope is refused", async () => {
  const { repository, service } = await outcomeReportHarness();

  for (const scope of [
    { kind: "global" as const },
    {
      kind: "workspace" as const,
      workspaceId: "workspace-other"
    },
    {
      kind: "repository" as const,
      workspaceId: "workspace-a",
      repositoryId: "repo-b"
    }
  ]) {
    await assert.rejects(
      service.recordOutcomeReport({
        report: outcomeReport({ scope }),
        actor: root,
        context
      }),
      MemoryAuthorizationError
    );
  }

  // A scope that matches but a taskId that does not is still the wrong session.
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ taskId: "task-other" }),
      actor: root,
      context
    }),
    MemoryAuthorizationError
  );
  assert.equal(repository.outcomeReports.size, 0);
});

test("an outcome report needs a correlation token and evidence for a decided outcome", async () => {
  const { repository, service } = await outcomeReportHarness();

  // The blank token and the unresolvable token are both MemoryValidationError,
  // so the message is the only thing that separates "you sent nothing" from
  // "that token does not resolve in your session".
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ correlationToken: "   " }),
      actor: root,
      context
    }),
    /correlationToken is required/u
  );
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ correlationToken: "no-such-token" }),
      actor: root,
      context
    }),
    /no scope-aligned injection event/u
  );
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ evidence: [] }),
      actor: root,
      context
    }),
    MemoryValidationError
  );
  assert.equal(repository.outcomeReports.size, 0);

  // "unknown" is the reporter declining to decide, so it needs no citation.
  const result = await service.recordOutcomeReport({
    report: outcomeReport({ outcomeKind: "unknown", evidence: [] }),
    actor: root,
    context
  });
  assert.equal(result.id, "private-outcome-report-id");
});

test("an outcome report must target an injection event in the reporter's own session", async () => {
  const { repository, service } = await outcomeReportHarness();

  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ correlationToken: "no-such-token" }),
      actor: root,
      context
    }),
    MemoryValidationError
  );

  // A token that does exist, but under a different session's injection event.
  // The reporter stays on its own session, so the token cannot be resolved.
  await persistOutcomeInjection(
    repository,
    service,
    outcomeInjectionEvent({
      id: "other-injection-id",
      correlationToken: "other-session-token",
      taskId: "task-other",
      runId: "run-other",
      agentId: "agent-other"
    })
  );
  await assert.rejects(
    service.recordOutcomeReport({
      report: outcomeReport({ correlationToken: "other-session-token" }),
      actor: root,
      context
    }),
    MemoryValidationError
  );
  assert.equal(repository.outcomeReports.size, 0);
});

test("an outcome report joins its injection event on the session, not on the request", async () => {
  const { repository, service } = await makeOutcomeHarnessAcrossRequests();

  const result = await service.recordOutcomeReport({
    report: outcomeReport(),
    actor: root,
    context
  });

  // The stored event keeps request-level identity the reporter never had. The
  // service's job is to forward the reporter's own session identity in the
  // lookup and leave the event's run/agent out of the comparison; the
  // repository double enforces that by matching on workspace/task only.
  assert.equal(result.id, "private-outcome-report-id");
  assert.equal(
    repository.injectionEvents.get("private-correlation-token")?.runId,
    "private-injection-run-id"
  );
  const lookup = repository.outcomeReportLookups[0];
  assert.equal(lookup?.correlationToken, "private-correlation-token");
  assert.equal(lookup?.lookupContext.workspaceId, "workspace-a");
  assert.equal(lookup?.lookupContext.taskId, "task-current");
  assert.equal(lookup?.lookupContext.runId, "run-current");
  assert.equal(lookup?.lookupContext.agentId, "agent-current");
});

async function makeOutcomeHarnessAcrossRequests(): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
}> {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  repository.injectionEvents.set(
    "private-correlation-token",
    outcomeInjectionEvent()
  );
  return { repository, service };
}

/**
 * The write path that records every observed memory injection. Its bounds are
 * what keep one event from smuggling an unbounded token, id list, packet size
 * or credentialed locator into the append-only store.
 */
function injectionEventRequest(
  overrides: Partial<MemoryInjectionEvent> = {}
): {
  readonly event: MemoryInjectionEvent;
  readonly context: MemoryReadContext;
} {
  const event = outcomeInjectionEvent(overrides);
  return {
    event,
    context: {
      ...context,
      taskId: event.taskId,
      runId: event.runId,
      agentId: event.agentId
    }
  };
}

async function recordInjectionEvent(
  service: MemoryService,
  overrides: Partial<MemoryInjectionEvent> = {}
): Promise<{ readonly appended: boolean; readonly id: string }> {
  const { event, context: eventContext } = injectionEventRequest(overrides);
  return service.recordInjectionEvent({ event, actor: root, context: eventContext });
}

test("an injection event is restricted to the trusted session's workspace, task, run and agent", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const { event } = injectionEventRequest();

  for (const override of [
    { workspaceId: "workspace-other" },
    { taskId: "task-other" },
    { runId: "run-other" },
    { agentId: "agent-other" }
  ]) {
    await assert.rejects(
      service.recordInjectionEvent({
        event: { ...event, ...override },
        actor: root,
        context: {
          ...context,
          taskId: event.taskId,
          runId: event.runId,
          agentId: event.agentId
        }
      }),
      MemoryAuthorizationError
    );
  }
  assert.equal(repository.injectionEvents.size, 0);
});

test("an injection event needs a bounded correlation token", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    recordInjectionEvent(service, { correlationToken: "   " }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { correlationToken: "t".repeat(257) }),
    MemoryValidationError
  );
  assert.equal(repository.injectionEvents.size, 0);

  // 256 is the bound, so it must still be accepted.
  const result = await recordInjectionEvent(service, {
    correlationToken: "t".repeat(256)
  });
  assert.equal(result.appended, true);
});

test("an injection event bounds the memory ids it references", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    recordInjectionEvent(service, {
      memoryIds: Array.from({ length: 65 }, (_unused, index) => `memory-${index}`)
    }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { memoryIds: ["   "] }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { memoryIds: ["m".repeat(257)] }),
    MemoryValidationError
  );
  assert.equal(repository.injectionEvents.size, 0);
});

test("an injection event bounds the packet size it claims to have carried", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    recordInjectionEvent(service, { packetCharacterCount: -1 }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { packetCharacterCount: 24_001 }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { packetCharacterCount: 1.5 }),
    MemoryValidationError
  );
  // The token count is optional, but a supplied one is bounded too.
  await assert.rejects(
    recordInjectionEvent(service, { packetTokenCount: -1 }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { packetTokenCount: 8001 }),
    MemoryValidationError
  );
  assert.equal(repository.injectionEvents.size, 0);

  const result = await recordInjectionEvent(service, {
    packetCharacterCount: 24_000,
    packetTokenCount: 8000
  });
  assert.equal(result.appended, true);
});

test("an injection event bounds its evidence references", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    recordInjectionEvent(service, {
      evidence: [{ kind: "document", uri: "u".repeat(2049) }]
    }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, {
      evidence: [{ kind: "commit", uri: "https://example.test/x", revision: "r".repeat(257) }]
    }),
    MemoryValidationError
  );
  await assert.rejects(
    recordInjectionEvent(service, { evidence: [{ kind: "document", uri: "" }] }),
    MemoryValidationError
  );
  assert.equal(repository.injectionEvents.size, 0);
});

test("an injection event's evidence is stripped of credentials before storage", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await recordInjectionEvent(service, {
    evidence: [
      {
        kind: "pull_request",
        uri: "https://user:pass@example.test/repo/pull/1?token=do-not-store#frag",
        revision: "abc123"
      }
    ]
  });

  const stored = repository.injectionEvents.get("private-correlation-token");
  const uri = stored?.evidence[0]?.uri ?? "";
  assert.equal(uri.includes("do-not-store"), false);
  assert.equal(uri.includes("pass"), false);
  assert.equal(uri.includes("frag"), false);
  // The locator itself survives, so the evidence still points somewhere real.
  assert.equal(uri, "https://example.test/repo/pull/1");
  assert.equal(stored?.evidence[0]?.revision, "abc123");
});

test("appending the same experience twice is a conflict, not a silent overwrite", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const envelope = experience();
  const appendContext = {
    ...context,
    taskId: envelope.taskId,
    runId: envelope.runId
  };

  await service.appendExperience(envelope, worker, appendContext);
  await assert.rejects(
    service.appendExperience(envelope, worker, appendContext),
    MemoryConflictError
  );
  assert.equal(repository.experiences.size, 1);
});

test("an experience bounds the evidence references it carries", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const envelope = experience();
  const appendContext = {
    ...context,
    taskId: envelope.taskId,
    runId: envelope.runId
  };
  const manyReferences = Array.from({ length: 65 }, (_unused, index) => ({
    kind: "document" as const,
    uri: `https://example.test/ref-${index}`
  }));

  await assert.rejects(
    service.appendExperience(
      { ...envelope, evidence: manyReferences },
      worker,
      appendContext
    ),
    MemoryValidationError
  );
  await assert.rejects(
    service.appendExperience(
      {
        ...envelope,
        validation: { state: "passed", evidence: manyReferences }
      },
      worker,
      appendContext
    ),
    MemoryValidationError
  );
  assert.equal(repository.experiences.size, 0);
});

test("an experience strips credentials from its trajectory, task and plan locators", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const envelope = experience();
  const appendContext = {
    ...context,
    taskId: envelope.taskId,
    runId: envelope.runId
  };

  await service.appendExperience(
    {
      ...envelope,
      trajectory: {
        ...envelope.trajectory,
        uri: "file:///tmp/run.jsonl?token=do-not-store"
      },
      evidence: [
        {
          kind: "document",
          uri: "https://user:pass@example.test/evidence?api_key=do-not-store#frag"
        }
      ],
      taskReference: {
        kind: "issue",
        uri: "https://example.test/task?access_token=do-not-store"
      },
      planReference: {
        kind: "document",
        uri: "https://example.test/plan?token=do-not-store"
      }
    },
    worker,
    appendContext
  );

  const stored = repository.experiences.get(envelope.id);
  const uris = [
    stored?.trajectory.uri ?? "",
    stored?.evidence[0]?.uri ?? "",
    stored?.taskReference?.uri ?? "",
    stored?.planReference?.uri ?? ""
  ];
  for (const uri of uris) {
    assert.equal(uri.includes("do-not-store"), false, `leaked in ${uri}`);
  }
  assert.equal(stored?.evidence[0]?.uri.includes("pass"), false);
  assert.equal(stored?.evidence[0]?.uri.includes("frag"), false);
  // The locators survive; only the credentials are gone.
  assert.equal(stored?.planReference?.uri, "https://example.test/plan");
});

/**
 * The curator's use-assessment write path. Three guards decide whether an
 * assessment can be attributed to an experience at all, and none was covered.
 */
function workspaceScopedExperience(
  id: string,
  repositoryId: string | undefined
): ExperienceEnvelope {
  // `exactOptionalPropertyTypes` makes an absent key and an explicit undefined
  // different, so a scope that names no repository has to drop the field.
  const { repositoryId: _dropped, ...withoutRepository } = experience(id);
  return repositoryId === undefined
    ? { ...withoutRepository, scope: { kind: "workspace", workspaceId: "workspace-a" } }
    : {
        ...withoutRepository,
        repositoryId,
        scope: { kind: "workspace", workspaceId: "workspace-a" }
      };
}

async function useReportHarness(
  envelope: ExperienceEnvelope = experience()
): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
}> {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  // Appended under the envelope's own repository: the read that follows is
  // what has to notice the caller is somewhere else.
  await service.appendExperience(envelope, worker, {
    ...context,
    ...(envelope.repositoryId ? { repositoryId: envelope.repositoryId } : {}),
    taskId: envelope.taskId,
    runId: envelope.runId
  });
  return { repository, service };
}

function useReportInput(
  envelope: ExperienceEnvelope,
  overrides: {
    readonly useKind?: string;
    readonly context?: MemoryReadContext;
  } = {}
): {
  readonly experienceId: string;
  readonly injectionEventId: string;
  readonly useKind: MemoryUseKind;
  readonly usedMemoryIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
} {
  return {
    experienceId: envelope.id,
    injectionEventId: "private-injection-id",
    useKind: "used" as MemoryUseKind,
    usedMemoryIds: ["mem-use-1", "mem-use-2"],
    evidence: [{ kind: "trajectory", uri: envelope.trajectory.uri }],
    actor: root,
    context: { ...context, canReadTaskHistory: true },
    ...(overrides.useKind === undefined
      ? {}
      : { useKind: overrides.useKind as MemoryUseKind }),
    ...(overrides.context ? { context: overrides.context } : {})
  };
}

test("a use report needs a use kind from the vocabulary", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.recordInjectionUseReport(
      useReportInput(experience(), { useKind: "not-a-kind" })
    ),
    /useKind is invalid/u
  );

  // A valid kind gets past this guard and fails on the missing experience
  // instead, which is what shows the two refusals are different.
  await assert.rejects(
    service.recordInjectionUseReport(useReportInput(experience())),
    /visible repository-scoped experience/u
  );
});

test("a use report needs a visible experience that names a repository", async () => {
  // Workspace-visible, but it never says which repository the run belonged to,
  // so there is nothing for the use report to be attributed to.
  const { service } = await useReportHarness(
    workspaceScopedExperience("experience-1", undefined)
  );

  await assert.rejects(
    service.recordInjectionUseReport(useReportInput(workspaceScopedExperience("experience-1", undefined))),
    /visible repository-scoped experience/u
  );

  // An experience the caller cannot see at all is refused the same way, rather
  // than leaking that the id exists.
  const foreign: ExperienceEnvelope = {
    ...experience("experience-foreign"),
    repositoryId: "repo-b",
    scope: {
      kind: "repository",
      workspaceId: "workspace-a",
      repositoryId: "repo-b"
    }
  };
  const { service: otherService, repository } = await useReportHarness();
  repository.experiences.set(foreign.id, foreign);
  await assert.rejects(
    otherService.recordInjectionUseReport(useReportInput(foreign)),
    /visible repository-scoped experience/u
  );
});

test("a use report is refused for an experience outside the caller's repository", async () => {
  // Workspace scope makes this visible from any repository in the workspace,
  // which is exactly why the service has to re-check the repository itself.
  const { service } = await useReportHarness(
    workspaceScopedExperience("experience-1", "repo-b")
  );

  await assert.rejects(
    service.recordInjectionUseReport(
      useReportInput(workspaceScopedExperience("experience-1", "repo-b"))
    ),
    MemoryAuthorizationError
  );

  // Same shape, matching repository: the guard is satisfied and the read moves
  // on to resolving the injection event.
  const matchingEnvelope = workspaceScopedExperience("experience-1", "repo-a");
  const { service: matchingService } = await useReportHarness(matchingEnvelope);
  await assert.rejects(
    matchingService.recordInjectionUseReport(useReportInput(matchingEnvelope)),
    /outside the captured session/u
  );
});

/**
 * The remaining promotion guards. Promoting a procedure writes a canonical
 * skill that other agents load by name, so a re-promotion that silently
 * re-points or accepts a drifted artifact is worse than a refusal.
 */
test("a procedure already promoted cannot be re-pointed at a different canonical skill", async () => {
  const { repository, service, current } = await promotableProcedure();

  await service.promoteProcedureToSkill(
    current.id,
    SKILL_INPUT,
    root,
    researchRequest()
  );

  // Same procedure, different skill name: the first artifact would be orphaned.
  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      { ...SKILL_INPUT, name: "some-other-skill" },
      root,
      researchRequest()
    ),
    /already promoted to a different canonical skill/u
  );
  assert.equal(
    repository.events.filter((event) => event.action === "procedure_promoted")
      .length,
    1
  );
});

test("a canonical skill that drifted from its recorded revision is a conflict, not a re-promotion", async () => {
  const { repository, current } = await promotableProcedure();

  const drifted = makeService(repository, {
    skillPromotionWriter: {
      createSkill: async ({ name }) => ({
        name,
        path: `.rulesync/skills/${name}/SKILL.md`,
        uri: `rulesync://skills/${name}/SKILL.md`,
        revision: "d".repeat(64)
      })
    }
  });

  // Promote on disk through the real writer, then read it back with a writer
  // that reports a different revision: the artifact moved under us.
  const first = await makeService(repository, {
    skillPromotionWriter: SKILL_WRITER
  }).promoteProcedureToSkill(
    current.id,
    SKILL_INPUT,
    root,
    researchRequest()
  );
  assert.equal(first.skill.revision, "c".repeat(64));

  await assert.rejects(
    drifted.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /differs from its recorded promotion revision/u
  );
});

test("skill promotion needs a configured canonical writer", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const current = record("procedure-candidate", { kind: "procedural" });
  repository.memories.set(current.id, current);

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /not configured/u
  );
});

test("only a procedural memory can become a canonical skill", async () => {
  const { service, current } = await promotableProcedure({ kind: "semantic" });

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /visible procedural memory/u
  );
});

test("skill promotion bounds the name, description and content it writes", async () => {
  for (const input of [
    { ...SKILL_INPUT, name: "-leading-dash" },
    { ...SKILL_INPUT, name: "trailing-dash-" },
    { ...SKILL_INPUT, name: "double--dash" },
    { ...SKILL_INPUT, name: "Not Lowercase" },
    { ...SKILL_INPUT, description: "" },
    { ...SKILL_INPUT, description: "d".repeat(513) },
    { ...SKILL_INPUT, content: "" },
    { ...SKILL_INPUT, content: "c".repeat(20_001) }
  ]) {
    const { service, current } = await promotableProcedure();
    await assert.rejects(
      service.promoteProcedureToSkill(
        current.id,
        input,
        root,
        researchRequest()
      ),
      /exceeds its validation bound/u,
      `expected ${JSON.stringify(input).slice(0, 60)} to be refused`
    );
  }
});

test("two citations to the same run are not two validated runs", async () => {
  // The provenance names two experience ids, but both resolve to one run, so
  // the distinct-run count is one and promotion must not graduate the memory.
  const { service, current } = await promotableProcedure({
    provenance: {
      experienceIds: ["success-run-a", "success-run-a"],
      evidence: [source],
      createdBy: root.id,
      createdAt: "2026-09-30T10:00:00.000Z"
    }
  });

  await assert.rejects(
    service.promoteProcedureToSkill(
      current.id,
      SKILL_INPUT,
      root,
      researchRequest()
    ),
    /two distinct successful runs/u
  );
});

test("only a live memory record can be invalidated", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const invalidated = record("already-gone", { status: "invalidated" });
  const superseded = record("already-superseded", { status: "superseded" });
  repository.memories.set(invalidated.id, invalidated);
  repository.memories.set(superseded.id, superseded);

  for (const target of [invalidated, superseded]) {
    await assert.rejects(
      service.invalidate(target.id, root, context, [source]),
      /live memory records/u
    );
  }
  assert.equal(repository.events.length, 0);
});

/**
 * The use-assessment join. Its two filter validators run on every call but had
 * no failing test, so "this filter cannot apply" had never been distinguished
 * from "nothing matches it".
 */
function useJoinRequest(
  overrides: Partial<MemoryInjectionUseJoinRequest> = {}
): MemoryInjectionUseJoinRequest {
  return {
    context: { ...context, canReadTaskHistory: true },
    ...overrides
  };
}

test("the use-assessment join refuses a memory mode outside the vocabulary", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.listInjectionUseJoins(
      useJoinRequest({
        memoryModes: ["not-a-mode"] as unknown as MemoryExecutionMode[]
      })
    ),
    /memory mode filter is invalid/u
  );
  assert.equal(repository.useJoinRequests.length, 0);
});

test("the use-assessment join refuses a use kind outside the vocabulary", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.listInjectionUseJoins(
      useJoinRequest({
        useKinds: ["not-a-use-kind"] as unknown as MemoryUseKind[]
      })
    ),
    /useKind filter is invalid/u
  );
  assert.equal(repository.useJoinRequests.length, 0);
});

test("the use-assessment join looks its session up without request-level identity", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await persistOutcomeInjection(repository, service, useInjectionEvent());

  const page = await service.listInjectionUseJoins(
    useJoinRequest({
      includeUnassessed: true,
      // The use-assessment join is session-scoped, so the caller reads the
      // session the event was captured in, not the one it is running in.
      context: { ...context, taskId: "task-old", canReadTaskHistory: true }
    })
  );

  // The stored event keeps its own run/agent; the read must join on the session
  // alone, so the context handed to storage deliberately omits both.
  assert.equal(page.items.length, 1);
  const sent = repository.useJoinRequests[0]?.context;
  assert.equal(sent?.workspaceId, "workspace-a");
  assert.equal(sent?.taskId, "task-old");
  assert.equal("runId" in (sent ?? {}), false);
  assert.equal("agentId" in (sent ?? {}), false);
});

test("use-assessment cohorts refuse a caller without task history", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  // A cohort aggregate is workspace/repository scoped: selecting a role, task,
  // run or agent would make the counts per-request rather than per-session.
  const cohortContext: MemoryReadContext = {
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    canReadGlobal: false
  };
  const window = {
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-10-01T00:00:00.000Z"
  } as const;

  await assert.rejects(
    service.aggregateInjectionUseCohorts({ context: cohortContext, ...window }),
    MemoryAuthorizationError
  );
  assert.equal(repository.useCohortRequests.length, 0);

  const page = await service.aggregateInjectionUseCohorts({
    context: { ...cohortContext, canReadTaskHistory: true },
    ...window
  });
  assert.equal(page.exposureCount, 0);
  assert.equal(repository.useCohortRequests.length, 1);
});

/**
 * The retention erasure path: a batch, irreversible delete over every expired
 * experience in a scope. `purgeExpiredExperiences` had no test reference at all,
 * so none of the bounds that decide how much is deleted, or from where, were
 * held by anything.
 */
function retentionContext(): MemoryReadContext {
  return {
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    canReadGlobal: false,
    canReadTaskHistory: true
  };
}

test("retention requires an explicit workspace and repository to erase from", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const input = {
    completedBefore: "2026-09-01T00:00:00.000Z",
    limit: 10,
    actor: root
  };

  for (const scope of [
    { workspaceId: "  ", repositoryId: "repo-a", canReadGlobal: false },
    { workspaceId: "workspace-a", canReadGlobal: false },
    { workspaceId: "workspace-a", repositoryId: "   ", canReadGlobal: false }
  ]) {
    await assert.rejects(
      service.purgeExpiredExperiences({
        ...input,
        context: { ...scope, canReadTaskHistory: true }
      }),
      /explicit workspace and repository/u
    );
  }
  assert.equal(repository.purgeRequests.length, 0);
});

test("retention refuses a cutoff or batch it cannot honour", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const expired = experience("expired-one");
  await repository.appendExperience(expired);

  for (const bounds of [
    { completedBefore: "not-a-date", limit: 10 },
    // A cutoff in the future would select everything that has not expired yet.
    { completedBefore: "2099-01-01T00:00:00.000Z", limit: 10 },
    { completedBefore: "2026-09-01T00:00:00.000Z", limit: 0 },
    { completedBefore: "2026-09-01T00:00:00.000Z", limit: 101 },
    { completedBefore: "2026-09-01T00:00:00.000Z", limit: 1.5 }
  ]) {
    await assert.rejects(
      service.purgeExpiredExperiences({
        ...bounds,
        actor: root,
        context: retentionContext()
      }),
      /scan bounds are invalid/u,
      `expected ${JSON.stringify(bounds)} to be refused`
    );
  }
  // Nothing was erased while the bounds were being argued about.
  assert.equal(repository.experiences.has("expired-one"), true);
  assert.equal(repository.purgeRequests.length, 0);
});

test("retention erases only expired, unreferenced, visible experiences", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const now = "2026-09-30T10:00:00.000Z";
  const expired = experience("expired-one");
  await repository.appendExperience({
    ...expired,
    completedAt: "2026-09-01T00:00:00.000Z"
  });
  // A run that never completed has no completedAt at all; an absent key and an
  // explicit undefined are different under exactOptionalPropertyTypes.
  const { completedAt: _stillRunning, ...stillRunning } = experience(
    "still-running"
  );
  await repository.appendExperience(stillRunning);
  await repository.appendExperience({
    ...experience("referenced-one"),
    completedAt: "2026-09-01T00:00:00.000Z"
  });
  repository.memories.set("mem-refs-it", {
    ...record("mem-refs-it"),
    provenance: {
      experienceIds: ["referenced-one"],
      evidence: [source],
      createdBy: root.id,
      createdAt: now
    }
  });
  await repository.appendExperience({
    ...experience("foreign-repo"),
    completedAt: "2026-09-01T00:00:00.000Z",
    repositoryId: "repo-b",
    scope: { kind: "repository", workspaceId: "workspace-a", repositoryId: "repo-b" }
  });

  const report = await service.purgeExpiredExperiences({
    completedBefore: "2026-09-15T00:00:00.000Z",
    limit: 10,
    actor: root,
    context: retentionContext()
  });

  assert.deepEqual(report, {
    selected: 1,
    purged: 1,
    referencedByMemory: 0,
    noLongerVisible: 0
  });
  assert.equal(repository.experiences.has("expired-one"), false);
  // An experience that has not completed, one a memory still cites, and one in
  // another repository all survive: none of them is an expired orphan here.
  // The not-completed and referenced exclusions come from the scan query
  // (buildExpiredExperienceQuery carries the same NOT EXISTS check), and the
  // repository scopes the scan to the caller's context as well. The service
  // re-checks visibility after the read so an over-returning repository still
  // cannot be erased from; that re-check is not what this assertion exercises.
  assert.equal(repository.experiences.has("still-running"), true);
  assert.equal(repository.experiences.has("referenced-one"), true);
  assert.equal(repository.experiences.has("foreign-repo"), true);
});

test("purging an experience needs a bounded id and a known reason", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  await assert.rejects(
    service.purgeExperience(
      "   ",
      "privacy_request",
      root,
      retentionContext()
    ),
    /experience id is invalid/u
  );
  await assert.rejects(
    service.purgeExperience(
      "e".repeat(257),
      "privacy_request",
      root,
      retentionContext()
    ),
    /experience id is invalid/u
  );
  await assert.rejects(
    service.purgeExperience(
      "experience-1",
      "not-a-reason" as MemoryExperiencePurgeReason,
      root,
      retentionContext()
    ),
    /purge reason is invalid/u
  );
  assert.equal(repository.purgeRequests.length, 0);

  assert.equal(
    await service.purgeExperience(
      "experience-1",
      "privacy_request",
      root,
      retentionContext()
    ),
    "not_visible"
  );
});

/**
 * The session-level outcome report: one report per (workspace, repository,
 * task), read back by session key. The workspace guard on the read was covered;
 * the repository and task-history guards were not, and the write path's session
 * restriction and conflict translation were not either.
 */
function sessionReportKey(
  workspaceId: string,
  repositoryId: string,
  taskId: string
): string {
  return `${workspaceId}\u0000${repositoryId}\u0000${taskId}`;
}

test("reading a session outcome report is scoped to the caller's repository", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  repository.sessionOutcomeReports.set(
    sessionReportKey("workspace-a", "repo-a", "task-current"),
    sessionOutcomeReportHelper()
  );

  await assert.rejects(
    service.getSessionOutcomeReport("workspace-a", "repo-a", "task-current", {
      ...context,
      repositoryId: "repo-b"
    }),
    MemoryAuthorizationError
  );

  // A context with no repository at all is not a claim of one, so it may ask
  // about the repository it named.
  const found = await service.getSessionOutcomeReport(
    "workspace-a",
    "repo-a",
    "task-current",
    { workspaceId: "workspace-a", taskId: "task-current", canReadGlobal: false }
  );
  assert.equal(found?.taskId, "task-current");
});

test("reading another session's outcome report needs the curator grant", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  repository.sessionOutcomeReports.set(
    sessionReportKey("workspace-a", "repo-a", "task-other"),
    sessionOutcomeReportHelper({ taskId: "task-other" })
  );

  await assert.rejects(
    service.getSessionOutcomeReport(
      "workspace-a",
      "repo-a",
      "task-other",
      context
    ),
    MemoryAuthorizationError
  );

  // The same read is permitted once the curator has task-history access.
  const found = await service.getSessionOutcomeReport(
    "workspace-a",
    "repo-a",
    "task-other",
    { ...context, canReadTaskHistory: true }
  );
  assert.equal(found?.taskId, "task-other");
});

test("a session outcome report is refused outside the trusted session", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);

  for (const override of [
    { workspaceId: "workspace-other" },
    { repositoryId: "repo-b" },
    { taskId: "task-other" }
  ]) {
    await assert.rejects(
      service.recordSessionOutcomeReport({
        report: sessionOutcomeReportHelper(override),
        actor: root,
        context
      }),
      MemoryAuthorizationError
    );
  }
  await assert.rejects(
    service.recordSessionOutcomeReport({
      report: sessionOutcomeReportHelper({ evidence: [] }),
      actor: root,
      context
    }),
    MemoryValidationError
  );
  assert.equal(repository.sessionOutcomeReports.size, 0);
});

test("one session accepts one report: a retry is a no-op, a different body is a conflict", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  const key = sessionReportKey("workspace-a", "repo-a", "task-current");

  const first = await service.recordSessionOutcomeReport({
    report: sessionOutcomeReportHelper(),
    actor: root,
    context
  });
  assert.equal(first.appended, true);

  const retry = await service.recordSessionOutcomeReport({
    report: sessionOutcomeReportHelper(),
    actor: root,
    context
  });
  assert.equal(retry.appended, false);

  await assert.rejects(
    service.recordSessionOutcomeReport({
      report: sessionOutcomeReportHelper({ outcomeKind: "failure" }),
      actor: root,
      context
    }),
    MemoryConflictError
  );
  // The first report is still the one on record.
  assert.equal(repository.sessionOutcomeReports.get(key)?.outcomeKind, "success");
});

/**
 * Why a candidate was dropped. `research` is the only producer of injected
 * packets, so this taxonomy is the answer to "why is memory not reaching the
 * model" -- and the reason is a metric dimension operators actually read.
 */
const DISPOSITIONS: Readonly<
  Record<string, ReconstructionOutcome["disposition"]>
> = {
  kept: "retain",
  "dropped-low-relevance": "reject",
  "dropped-uncertain": "uncertain",
  "dropped-retain-no-guidance": "retain",
  "dropped-revise-no-guidance": "revise"
};
const NO_GUIDANCE_IDS: ReadonlySet<string> = new Set([
  "dropped-retain-no-guidance",
  "dropped-revise-no-guidance"
]);

function rejectionHarness(): {
  readonly service: MemoryService;
  readonly provider: MeterProvider;
  readonly exporter: InMemoryMetricExporter;
} {
  const repository = new FakeMemoryRepository();
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000
      })
    ]
  });

  // One memory per rejection shape, so both the disposition and the current
  // state answer are decided per record.
  const service = makeService(repository, {
    meter: provider.getMeter("autodev.memory.research-test"),
    reconstruct: (memory) => ({
      memoryId: memory.id,
      disposition: DISPOSITIONS[memory.id] ?? "retain",
      // An approved disposition that produced nothing usable is the case worth
      // naming: the reviewer liked the memory, and there is still no entry.
      ...(NO_GUIDANCE_IDS.has(memory.id)
        ? { guidance: "   " }
        : { guidance: `For this task, follow ${memory.claim}` }),
      rationale: "Current state confirms the cited procedure.",
      evidence: []
    }),
    assessment: (memory) => ({
      ...compatibleAssessment(),
      ...(memory.id === "dropped-contradicted"
        ? { compatibility: "contradicted" as const }
        : memory.id === "dropped-unknown"
          ? { compatibility: "unknown" as const }
          : memory.id === "dropped-no-evidence"
            ? { evidence: [] }
            : {})
    })
  });

  for (const id of [
    "kept",
    "dropped-contradicted",
    "dropped-unknown",
    "dropped-no-evidence",
    "dropped-low-relevance",
    "dropped-uncertain",
    "dropped-retain-no-guidance",
    "dropped-revise-no-guidance"
  ]) {
    repository.hits = [
      ...repository.hits,
      { memory: record(id), score: 1, matchedSignals: ["lexical"] }
    ];
  }
  return { service, provider, exporter };
}

function rejectionReasonCounts(
  exporter: InMemoryMetricExporter
): Map<string, number> {
  const metric = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((item) => item.descriptor.name === "autodev.memory.candidates");
  assert.ok(metric, "candidate metric should be exported");
  const counts = new Map<string, number>();
  for (const point of metric.dataPoints) {
    if (point.attributes["autodev.memory.candidate.stage"] !== "rejected")
      continue;
    const reason = String(point.attributes["autodev.memory.reason"]);
    counts.set(reason, (counts.get(reason) ?? 0) + Number(point.value));
  }
  return counts;
}

test("every way research drops a candidate reports a distinct reason", async () => {
  const { service, provider, exporter } = rejectionHarness();

  const packet = await service.research(researchRequest());
  await provider.forceFlush();

  // Only the memory that passed both stages reaches the packet.
  assert.deepEqual(
    packet.entries.map((entry) => entry.memoryId),
    ["kept"]
  );

  const counts = rejectionReasonCounts(exporter);
  assert.equal(counts.get("contradicted"), 1);
  // An unknown compatibility, a compatible one with no citation, and an
  // explicitly uncertain disposition all mean the same thing: unconfirmed.
  assert.equal(counts.get("uncertain"), 3);
  assert.equal(counts.get("low_relevance"), 1);
  // An approved "retain" or "revise" that yielded no usable guidance is
  // "nothing to inject", not a judgement about the memory's relevance.
  assert.equal(counts.get("rejected"), 2);
  assert.equal(
    [...counts.values()].reduce((total, value) => total + value, 0),
    7
  );
});
/**
 * The durable-memory proposal path. Every record in the store was written
 * through `createCandidate`, and four of its guards had no failing test: the
 * claim bound, the source-experience bound, the evidence requirement, and the
 * rule that only a live record may be revised.
 */
function proposalInput(
  overrides: Partial<{
    claim: string;
    experienceIds: readonly string[];
    evidence: readonly EvidenceReference[];
  }> = {}
): {
  readonly kind: "semantic";
  readonly scope: {
    readonly kind: "repository";
    readonly workspaceId: string;
    readonly repositoryId: string;
  };
  readonly claim: string;
  readonly experienceIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
} {
  return {
    kind: "semantic",
    scope: { kind: "repository", workspaceId: "workspace-a", repositoryId: "repo-a" },
    claim: "A claim whose evidence must be visible.",
    experienceIds: ["source-experience"],
    evidence: [source],
    ...overrides
  };
}

async function proposalHarness(): Promise<{
  readonly repository: FakeMemoryRepository;
  readonly service: MemoryService;
}> {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await repository.appendExperience(experience("source-experience"));
  return { repository, service };
}

test("a proposal needs a claim that survives as text and stays bounded", async () => {
  const { repository, service } = await proposalHarness();

  await assert.rejects(
    service.propose(proposalInput({ claim: "   " }), root, context),
    /must be concise and non-empty/u
  );
  await assert.rejects(
    service.propose(
      proposalInput({ claim: "c".repeat(4001) }),
      root,
      context
    ),
    /must be concise and non-empty/u
  );
  assert.equal(repository.memories.size, 0);

  // 4000 is the bound, so it must still be accepted.
  const accepted = await service.propose(
    proposalInput({ claim: "c".repeat(4000) }),
    root,
    context
  );
  assert.equal(accepted.claim.length, 4000);
});

test("a proposal needs a bounded set of source experiences it can actually cite", async () => {
  const { repository, service } = await proposalHarness();

  await assert.rejects(
    service.propose(proposalInput({ experienceIds: [] }), root, context),
    /bounded set of source experiences/u
  );
  await assert.rejects(
    service.propose(
      proposalInput({
        experienceIds: Array.from({ length: 65 }, (_unused, index) => `e-${index}`)
      }),
      root,
      context
    ),
    /bounded set of source experiences/u
  );
  await assert.rejects(
    service.propose(proposalInput({ experienceIds: ["   "] }), root, context),
    /bounded set of source experiences/u
  );
  await assert.rejects(
    service.propose(
      proposalInput({ experienceIds: ["e".repeat(257)] }),
      root,
      context
    ),
    /bounded set of source experiences/u
  );
  assert.equal(repository.memories.size, 0);

  // A duplicate citation is bounded too: the stored list is deduplicated.
  const accepted = await service.propose(
    proposalInput({ experienceIds: ["source-experience", "source-experience"] }),
    root,
    context
  );
  assert.deepEqual(accepted.provenance.experienceIds, ["source-experience"]);
});

test("a proposal needs evidence", async () => {
  const { repository, service } = await proposalHarness();

  await assert.rejects(
    service.propose(proposalInput({ evidence: [] }), root, context),
    /requires evidence references/u
  );
  assert.equal(repository.memories.size, 0);
});

test("only a live memory can be revised", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository);
  await repository.appendExperience(experience("source-experience"));

  for (const status of [
    "proposed",
    "invalidated",
    "superseded"
  ] as const) {
    const target = record(`target-${status}`, { status });
    repository.memories.set(target.id, target);
    await assert.rejects(
      service.revise(
        target.id,
        { claim: "A revised claim.", experienceIds: ["source-experience"], evidence: [source] },
        root,
        context
      ),
      /active or uncertain memory can be revised/u,
      `expected a ${status} record to be refused`
    );
  }
  await assert.rejects(
    service.revise(
      "no-such-record",
      { claim: "A revised claim.", experienceIds: ["source-experience"], evidence: [source] },
      root,
      context
    ),
    /active or uncertain memory can be revised/u
  );
  assert.equal(repository.events.length, 0);

  // "uncertain" is live: it is the one non-active status that may be revised.
  const uncertain = record("target-uncertain", { status: "uncertain" });
  repository.memories.set(uncertain.id, uncertain);
  const revised = await service.revise(
    uncertain.id,
    { claim: "A revised claim.", experienceIds: ["source-experience"], evidence: [source] },
    root,
    context
  );
  assert.equal(revised.status, "proposed");
  // The link back to the record being revised lives on the lifecycle event.
  assert.deepEqual(repository.events.at(-1)?.relatedMemoryIds, [uncertain.id]);
  assert.equal(repository.events.at(-1)?.action, "revised");
});
/**
 * Three invariants that were stated in comments and held by nothing: telemetry
 * is observational, the candidate cap is a real bound, and a use report cannot
 * smuggle an unbounded id list or evidence list past the service.
 */
function explodingMeter(): Meter {
  const boom = (): never => {
    throw new Error("telemetry backend is down");
  };
  return {
    createCounter: () => ({ add: boom, record: boom }),
    createHistogram: () => ({ add: boom, record: boom }),
    createGauge: () => ({ add: boom, record: boom })
  } as unknown as Meter;
}

test("telemetry is observational: a broken meter never fails a memory operation", async () => {
  const repository = new FakeMemoryRepository();
  const service = makeService(repository, { meter: explodingMeter() });
  await repository.appendExperience(experience("source-experience"));
  repository.hits = [
    { memory: record("candidate"), score: 1, matchedSignals: ["lexical"] }
  ];

  // `withSpan` records an operation counter and a duration for every call, so
  // every operation below hits the failing instruments at least once.
  const proposal = await service.propose(proposalInput(), root, context);
  assert.equal(proposal.status, "proposed");

  const packet = await service.research(researchRequest());
  assert.deepEqual(
    packet.entries.map((entry) => entry.memoryId),
    ["candidate"]
  );
  assert.equal(repository.memories.size, 1);
  assert.equal(repository.events.length, 1);
});

test("the reconstruction candidate cap is a bound, not a default", async () => {
  const repository = new FakeMemoryRepository();

  for (const maxResearchCandidates of [0, 41, 1.5]) {
    assert.throws(
      () => makeService(repository, { maxResearchCandidates }),
      /between 1 and 40/u,
      `expected ${maxResearchCandidates} to be refused`
    );
  }

  // Both ends of the accepted range.
  assert.ok(makeService(repository, { maxResearchCandidates: 1 }));
  assert.ok(makeService(repository, { maxResearchCandidates: 40 }));
  assert.ok(makeService(repository));
});

test("a use report bounds the memory ids and evidence it carries", async () => {
  const tooMany = (count: number): readonly string[] =>
    Array.from({ length: count }, (_unused, index) => `mem-${index}`);
  const manyEvidence = Array.from({ length: 65 }, (_unused, index) => ({
    kind: "document" as const,
    uri: `https://example.test/evidence-${index}`
  }));

  // The bounds sit after the event lookup, so the session has to be there.
  for (const [override, message] of [
    [{ usedMemoryIds: tooMany(65) }, /too many memory ids/u],
    [{ evidence: manyEvidence }, /[Tt]oo many injection-use evidence references/u]
  ] as const) {
    const { repository, service } = await useReportHarness();
    await persistOutcomeInjection(repository, service, useInjectionEvent());
    await assert.rejects(
      service.recordInjectionUseReport({
        ...useReportInput(experience()),
        ...override
      }),
      message
    );
  }

  // 64 memory ids is inside the bound, so it gets as far as the invariant that
  // asks them to actually be part of the injected packet -- a different check,
  // with its own message, one layer further on.
  const { repository, service } = await useReportHarness();
  await persistOutcomeInjection(repository, service, useInjectionEvent());
  await assert.rejects(
    service.recordInjectionUseReport({
      ...useReportInput(experience()),
      usedMemoryIds: tooMany(64)
    }),
    /subset of the injected memoryIds/u
  );
});

/**
 * How much of the research the packet dropped, and how much of it it kept.
 *
 * `boundPacket` walks reconstructed entries in rank order and stops adding once
 * the rendered text would exceed `maxPacketCharacters`. Everything it skips is
 * counted, and that count is the only thing an operator has when a memory they
 * expect to see never reaches the model — a silent omission reads exactly like a
 * memory the curator had already superseded.
 *
 * The count was emitted (`memory.packet.omitted`) but nothing held it: the
 * attribute set had no test, so "omitted is counted" and "omitted is reported"
 * were the same unverified claim. The count is what these tests read, together
 * with the per-candidate `packet_included`/`packet_omitted` metric stages that
 * say *which* memories were dropped rather than only how many.
 *
 * The span is read through the `tracer` the service already accepts, so this is
 * the service's own instrumentation and not a test-only path.
 */
function recordingTracer(attributes: Map<string, unknown>): Tracer {
  return {
    startActiveSpan(name: string, callback: (span: never) => Promise<unknown>) {
      return callback({
        setAttribute: (key: string, value: unknown) => {
          // Every span's attributes land in one map: these tests read the packet
          // span's, and the research span's, without caring which wrote a key.
          attributes.set(key, value);
          void name;
        },
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
}

/** A memory whose reconstruction is long enough to overflow a small packet. */
function bulkyRecord(id: string): MemoryRecord {
  return record(id, { claim: `${id}: a claim long enough to occupy real space in the packet body.` });
}

test("a packet that had to drop entries reports how many it dropped", async () => {
  // Four eligible memories, a bound that fits roughly one. `boundPacket` walks in
  // rank order and keeps what fits, so the omissions are a suffix of the ranking
  // rather than an arbitrary subset — that ordering is the property the count is
  // only meaningful alongside.
  const repository = new FakeMemoryRepository();
  const ids = ["mem-1", "mem-2", "mem-3", "mem-4"];
  repository.hits = ids.map((id) => ({
    memory: bulkyRecord(id),
    score: 1,
    matchedSignals: ["lexical"]
  }));
  const attributes = new Map<string, unknown>();
  const service = makeService(repository, {
    tracer: recordingTracer(attributes),
    reconstruct: () => ({
      disposition: "retain",
      guidance: "x".repeat(400),
      rationale: "The cited source is unchanged."
    })
  });

  const packet = await service.research(researchRequest({ maxPacketCharacters: 600 }));

  assert.ok(
    packet.entries.length < ids.length,
    `the fixture must overflow the bound; ${packet.entries.length} of ${ids.length} fit`
  );
  assert.equal(
    attributes.get("memory.packet.entries"),
    packet.entries.length,
    "the span reported a different entry count than the packet contains"
  );
  assert.equal(
    attributes.get("memory.packet.omitted"),
    ids.length - packet.entries.length,
    "the span did not report how many entries were dropped"
  );
  assert.equal(
    attributes.get("memory.packet.characters"),
    packet.characterCount
  );
});

test("a packet that dropped nothing reports zero, not an absent attribute", async () => {
  // The other edge, and the one a `if (omitted > 0)` guard would break. A missing
  // attribute and a zero mean the same thing to a reader and completely different
  // things to a dashboard: one is a gap in the data, the other is a healthy
  // packet.
  const repository = new FakeMemoryRepository();
  repository.hits = [
    { memory: bulkyRecord("mem-1"), score: 1, matchedSignals: ["lexical"] }
  ];
  const attributes = new Map<string, unknown>();
  const service = makeService(repository, {
    tracer: recordingTracer(attributes)
  });

  const packet = await service.research(researchRequest());

  assert.equal(packet.entries.length, 1, "the fixture did not fit; nothing to test");
  assert.equal(
    attributes.get("memory.packet.omitted"),
    0,
    "an untruncated packet did not report zero omissions"
  );
});

test("the omissions are the entries that did not fit, not an arbitrary subset", async () => {
  // The count alone is satisfied by any number, including a wrong one. This
  // pins the membership: the kept entries are a prefix of the ranking, because
  // `boundPacket` drops by `continue` and never reorders.
  const repository = new FakeMemoryRepository();
  const ids = ["mem-1", "mem-2", "mem-3", "mem-4"];
  repository.hits = ids.map((id) => ({
    memory: bulkyRecord(id),
    score: 1,
    matchedSignals: ["lexical"]
  }));
  const service = makeService(repository, {
    reconstruct: () => ({
      disposition: "retain",
      guidance: "x".repeat(200),
      rationale: "The cited source is unchanged."
    })
  });

  const packet = await service.research(researchRequest({ maxPacketCharacters: 900 }));
  const kept = packet.entries.map((entry) => entry.memoryId);

  // At least two must fit, or the ordering claim below is vacuous: a prefix of
  // length one is a prefix however the entries are added. This assertion is what
  // stops the fixture from quietly degrading back to one entry.
  assert.ok(
    kept.length >= 2,
    `the fixture must admit at least two entries to observe ordering; it admitted ${kept.length}`
  );
  assert.ok(kept.length < ids.length, "the fixture dropped nothing");
  assert.deepEqual(
    kept,
    ids.slice(0, kept.length),
    "the kept entries are not a prefix of the ranking"
  );
});

/**
 * The seven MCP tools that had never been invoked by any test.
 *
 * The facade test above asserts the tool *list* and exercises four write tools.
 * Every handler that reads was therefore never executed: an agent-facing surface
 * with a workspace-scoping rule, and no test that a rule applies to it. The
 * write tools were already covered for exactly this — `memory_research` is
 * asserted to ignore an attacker-selected `workspaceId` — which makes the read
 * side the larger half of the gap, because a read tool that returns another
 * workspace's memory hands over exactly what the write tools refuse to accept.
 *
 * The arguments here deliberately carry a caller-selected workspace on every
 * call. None of these seven takes one, so the assertions are about the host
 * session binding instead: the two search tools are checked against the request
 * their repository recorded, and the four id-based reads are checked by asking
 * for an id that belongs to somebody else.
 */

const FOREIGN_WORKSPACE = {
  scope: {
    kind: "repository" as const,
    workspaceId: "workspace-b",
    repositoryId: "repo-b"
  },
  workspaceId: "workspace-b",
  repositoryId: "repo-b"
};

/** Connect a client bound to the `context` fixture's workspace. */
async function withMcpClient(
  repository: FakeMemoryRepository,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const service = makeService(repository);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMemoryMcpServer(service, {
    current: async () => ({
      actor: worker,
      context,
      taskId: "task-current",
      task: "Investigate memory MCP scope safety.",
      memoryMode: "unknown"
    })
  });
  const client = new Client(
    { name: "memory-read-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("every MCP read tool runs against the host session and ignores a caller-selected workspace", async () => {
  const repository = new FakeMemoryRepository();
  const visibleExperience = experience("visible-experience");
  repository.experiences.set(visibleExperience.id, visibleExperience);
  const visible = record("visible-record");
  repository.memories.set(visible.id, visible);
  repository.hits = [
    { memory: visible, score: 1, matchedSignals: ["lexical"] }
  ];

  await withMcpClient(repository, async (client) => {
    const call = async (
      name: string,
      args: Record<string, unknown>
    ): Promise<{ isError?: boolean; text: string }> => {
      const result = await client.callTool({ name, arguments: args });
      const first = (result.content as Array<{ text?: string }>)[0];
      return {
        // The SDK types `isError` as unknown, so narrow it here rather than
        // asserting against a value the client has not promised is boolean.
        ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
        text: first?.text ?? ""
      };
    };

    // Every call carries a workspaceId the caller chose. None of these tools
    // accepts one, so if any of them honoured it the request its repository
    // recorded below would say "attacker-selected-workspace".
    const search = await call("experience_search", {
      query: "retry",
      workspaceId: "attacker-selected-workspace"
    });
    assert.equal(
      search.isError,
      undefined,
      `experience_search failed: ${search.text}`
    );
    assert.equal(
      repository.experienceSearchRequests.at(-1)?.context.workspaceId,
      "workspace-a",
      "experience_search searched a workspace the caller chose"
    );

    const memorySearch = await call("memory_search", {
      query: "retry",
      workspaceId: "attacker-selected-workspace"
    });
    assert.equal(
      memorySearch.isError,
      undefined,
      `memory_search failed: ${memorySearch.text}`
    );
    assert.equal(
      repository.searchRequests.at(-1)?.context.workspaceId,
      "workspace-a",
      "memory_search searched a workspace the caller chose"
    );

    for (const [name, args] of [
      ["experience_get", { id: "visible-experience" }],
      ["memory_get", { id: "visible-record" }],
      ["memory_history", { id: "visible-record" }],
      ["memory_why", { id: "visible-record" }]
    ] as const) {
      const result = await call(name, {
        ...args,
        workspaceId: "attacker-selected-workspace"
      });
      assert.equal(result.isError, undefined, `${name} failed: ${result.text}`);
      assert.notEqual(
        result.text,
        "null",
        `${name} returned nothing for a record in the host's own workspace`
      );
    }

    const revised = await call("memory_revise", {
      id: "visible-record",
      claim: "Run the focused suite before the broad one.",
      experienceIds: ["visible-experience"],
      evidence: [source],
      workspaceId: "attacker-selected-workspace"
    });
    assert.equal(revised.isError, undefined, `memory_revise failed: ${revised.text}`);
  });
});

test("no MCP read tool returns an object belonging to another workspace", async () => {
  // The refusal half. An id is the only thing a read tool takes from the
  // caller, so "can I read this id" is the whole security question, and a tool
  // that answers with somebody else's record leaks precisely what the write
  // tools refuse to accept.
  const repository = new FakeMemoryRepository();
  const foreignExperience = experience("foreign-experience");
  repository.experiences.set(foreignExperience.id, {
    ...foreignExperience,
    ...FOREIGN_WORKSPACE,
    scope: FOREIGN_WORKSPACE.scope
  });
  const foreign = record("foreign-record", {
    ...FOREIGN_WORKSPACE,
    scope: FOREIGN_WORKSPACE.scope,
    provenance: {
      ...record("foreign-record").provenance,
      experienceIds: ["foreign-experience"]
    }
  });
  repository.memories.set(foreign.id, foreign);
  repository.hits = [
    { memory: foreign, score: 1, matchedSignals: ["lexical"] }
  ];
  // A visible record that *cites* the foreign experience, so `memory_why` has
  // something to over-report: the record is readable, and its provenance is not.
  const citing = record("citing-record", {
    provenance: {
      ...record("citing-record").provenance,
      experienceIds: ["foreign-experience"]
    }
  });
  repository.memories.set(citing.id, citing);

  await withMcpClient(repository, async (client) => {
    const call = async (
      name: string,
      args: Record<string, unknown>
    ): Promise<string> => {
      const result = await client.callTool({ name, arguments: args });
      const first = (result.content as Array<{ text?: string }>)[0];
      return first?.text ?? "";
    };

    for (const [name, args] of [
      ["experience_get", { id: "foreign-experience" }],
      ["memory_get", { id: "foreign-record" }],
      ["memory_history", { id: "foreign-record" }],
      ["memory_why", { id: "foreign-record" }]
    ] as const) {
      const text = await call(name, args);
      assert.doesNotMatch(
        text,
        /foreign-record|foreign-experience|workspace-b/u,
        `${name} returned an object from another workspace`
      );
    }

    // The case that is easy to miss, because nothing here looks like a
    // cross-workspace read: the record is *readable*, and its provenance cites
    // an experience that is not. `why` answers for the record it was asked
    // about, then walks that record's own provenance — so the record's
    // visibility says nothing about what its citations resolve to. Asking
    // `why` about the foreign record above does not cover this at all: that
    // stops at the record, before any provenance is read.
    const why = await call("memory_why", { id: "citing-record" });
    const whyResult = JSON.parse(why) as {
      readonly memory: { readonly id: string };
      readonly sourceExperiences: readonly { readonly id: string }[];
    };
    assert.equal(
      whyResult.memory.id,
      "citing-record",
      "the citing record is not readable, so the assertion below proves nothing"
    );
    // Scoped to `sourceExperiences`, not to the whole response: the record's
    // own provenance legitimately names the experience it cites, and matching
    // the id anywhere in the payload would fail on the record itself rather
    // than on anything the reader was not entitled to.
    assert.deepEqual(
      whyResult.sourceExperiences.map((experience) => experience.id),
      [],
      "why resolved a cited experience belonging to another workspace"
    );

    // The same for a search: the repository is asked with the host's context,
    // so a foreign record can only appear if the *service* stops filtering.
    const searched = await call("memory_search", { query: "suite" });
    assert.doesNotMatch(
      searched,
      /foreign-record/u,
      "memory_search returned a record from another workspace"
    );
  });
});
