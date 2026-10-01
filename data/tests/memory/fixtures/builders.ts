import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryLifecycleEvent,
  MemoryReadContext,
  MemoryRecord
} from "@simulatorlife/autodev-core";

export function makeContext(
  overrides: Partial<MemoryReadContext> = {}
): MemoryReadContext {
  return {
    workspaceId: "ws-1",
    canReadGlobal: false,
    ...overrides
  };
}

export function makeEvidence(uri: string): EvidenceReference {
  return { kind: "trace", uri };
}

export function makeExperience(
  overrides: Partial<ExperienceEnvelope> = {}
): ExperienceEnvelope {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    outcome: "success",
    trajectory: { format: "codex-v1", uri: "trajectory://exp-1" },
    evidence: [makeEvidence("file://a.ts")],
    ...overrides
  };
}

export function makeMemoryRecord(
  overrides: Partial<MemoryRecord> = {}
): MemoryRecord {
  return {
    id: "mem-1",
    kind: "semantic",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    claim: "The config loader reads execution-contract.json",
    status: "proposed",
    provenance: {
      experienceIds: ["exp-1"],
      evidence: [makeEvidence("file://config-repository.ts")],
      createdBy: "agent-1",
      createdAt: "2026-01-01T00:05:00.000Z"
    },
    validity: {
      state: "unverified",
      evidence: []
    },
    createdAt: "2026-01-01T00:05:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    ...overrides
  };
}

export function makeLifecycleEvent(
  overrides: Partial<MemoryLifecycleEvent> = {}
): MemoryLifecycleEvent {
  return {
    id: "evt-1",
    memoryId: "mem-1",
    action: "proposed",
    actorId: "agent-1",
    occurredAt: "2026-01-01T00:05:00.000Z",
    toStatus: "proposed",
    reasonCode: "candidate_submitted",
    evidence: [],
    relatedMemoryIds: [],
    ...overrides
  };
}
