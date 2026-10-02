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
  type EvidenceReference,
  type ExperienceEnvelope,
  isMemoryExperienceVisibleTo,
  type MemoryActor,
  type MemoryExperiencePurgeRequest,
  type MemoryExperiencePurgeResult,
  type MemoryExpiredExperienceRequest,
  type MemoryHistory,
  type MemoryLifecycleEvent,
  type MemoryPacket,
  type MemoryReadContext,
  type MemoryRecord,
  type MemoryRepository,
  type MemoryResearchRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemoryVersionedUpdate
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
  readonly events: MemoryLifecycleEvent[] = [];
  hits: readonly MemorySearchHit[] = [];
  readonly searchRequests: MemorySearchRequest[] = [];
  readonly proposalEmbeddings: (readonly number[] | undefined)[] = [];
  readonly purgeRequests: MemoryExperiencePurgeRequest[] = [];
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
  }> {
    const items = [...this.memories.values()];
    return { items, total: items.length, limit: 50, offset: 0 };
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

  await service.captureExperience(
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
