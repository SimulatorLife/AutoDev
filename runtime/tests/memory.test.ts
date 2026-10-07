import assert from "node:assert/strict";
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
  type MemoryExperiencePurgeRequest,
  type MemoryExperiencePurgeResult,
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
  type MemoryLifecycleEvent,
  type MemoryOutcomeReport,
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

  async searchExperiences(): Promise<readonly ExperienceEnvelope[]> {
    return [...this.experiences.values()];
  }

  async listExperiences(): Promise<{
    items: readonly ExperienceEnvelope[];
    total: number;
    limit: number;
    offset: number;
  }> {
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
    _context: MemoryInjectionEventSessionLookup,
    correlationToken: string
  ): Promise<MemoryInjectionEvent | null> {
    return this.injectionEvents.get(correlationToken) ?? null;
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

  async listInjectionOutcomeJoins(): Promise<{
    readonly items: readonly never[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }> {
    return { items: [], total: 0, limit: 50, offset: 0 };
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
      reconstruct: async ({ memory }) => ({
        disposition: "retain",
        guidance: `For this task, follow ${memory.claim}`,
        rationale: "Current state confirms the cited procedure."
      })
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
