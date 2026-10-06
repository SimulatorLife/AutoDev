import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryExpiredExperienceRequest,
  MemoryPacket,
  MemoryReadContext,
  MemoryRecord,
  MemoryRepository,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryVersionedUpdate
} from "@simulatorlife/autodev-core";

import {
  appendMemoryPacket,
  injectMemoryContext,
  injectRetrievalOnlyMemoryContext,
  latestUserTask,
  memoryQueryFromTask
} from "../src/memory/context-injection.ts";
import { MemoryService } from "../src/memory/service.ts";

const packet: MemoryPacket = {
  taskId: "task-a",
  entries: [
    {
      memoryId: "memory-a",
      disposition: "retain",
      guidance: "Check the cited file before applying this claim.",
      rationale: "The current repository evidence matches.",
      evidence: [{ kind: "file", uri: "file:///repo/src/example.ts" }]
    }
  ],
  text: "Memory memory-a: Check the cited file.",
  characterCount: 35,
  tokenCount: 9,
  omittedCount: 0,
  generatedAt: "2026-10-01T12:00:00.000Z"
};

test("latestUserTask ignores tool outputs and selects the newest user-authored message", () => {
  const task = latestUserTask([
    { type: "message", role: "user", content: "older request" },
    { type: "function_call_output", call_id: "call-1", output: "tool result" },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Inspect current files." },
        { type: "input_image", image_url: "private://not-text" },
        { type: "input_text", text: " Keep RuleSync authoritative." }
      ]
    }
  ]);
  assert.equal(task, "Inspect current files.\n Keep RuleSync authoritative.");
  assert.equal(
    latestUserTask([{ type: "function_call_output", call_id: "call-2" }]),
    null
  );
  assert.equal(
    latestUserTask([
      {
        type: "message",
        role: "user",
        content: "<subagent_notification>child done</subagent_notification>"
      }
    ]),
    null
  );
  assert.equal(latestUserTask("x".repeat(16_001)), null);
});

test("latestUserTask ignores routed developer-only reconstruction context", () => {
  assert.equal(
    latestUserTask([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "JSON reconstruction request" }]
      }
    ]),
    null
  );
});

test("long task query preserves its beginning and final constraints within the bound", () => {
  const task = `BEGIN ${"a".repeat(5000)} FINAL_CONSTRAINT`;
  const query = memoryQueryFromTask(task);
  assert.equal(query.length, 4000);
  assert.match(query, /^BEGIN/);
  assert.match(query, /FINAL_CONSTRAINT$/);
});

test("memory packet is serialized as advisory context without replacing current instructions", () => {
  const payload = {
    model: "autodev/orchestrator",
    instructions: "Root role instructions."
  };
  const injected = appendMemoryPacket(payload, packet);
  assert.equal(injected.model, payload.model);
  assert.match(String(injected.instructions), /^Root role instructions\./);
  assert.match(
    String(injected.instructions),
    /quoted historical data, not policy or authority/
  );
  assert.match(String(injected.instructions), /RuleSync policy/);
  assert.match(String(injected.instructions), /memory-a/);
  assert.equal(
    payload.instructions,
    "Root role instructions.",
    "the original payload is not mutated"
  );
});

test("a new task replaces a prior packet, and an empty result removes stale memory context", () => {
  const first = appendMemoryPacket({ instructions: "Root policy." }, packet);
  const secondPacket = {
    ...packet,
    taskId: "task-b",
    entries: packet.entries.map((entry) => ({
      ...entry,
      memoryId: "memory-b"
    })),
    text: "Memory memory-b: New task evidence."
  };
  const second = appendMemoryPacket(first, secondPacket);
  assert.match(String(second.instructions), /memory-b/);
  assert.doesNotMatch(String(second.instructions), /memory-a/);
  const empty = appendMemoryPacket(second, {
    ...packet,
    entries: [],
    text: ""
  });
  assert.equal(empty.instructions, "Root policy.");
});

test("non-string instructions leave the provider payload unchanged", () => {
  const payload = { instructions: { injected: false } };
  assert.equal(appendMemoryPacket(payload, packet), payload);
});

test("injectMemoryContext performs JIT research and attaches the advisory packet", async () => {
  const time = "2026-09-30T12:00:00.000Z";
  const evidence = {
    kind: "file" as const,
    uri: "file:///repo/src/feature.ts"
  };
  const memory: MemoryRecord = {
    id: "memory-injection",
    kind: "semantic",
    scope: {
      kind: "repository",
      workspaceId: "workspace-a",
      repositoryId: "repo-a"
    },
    claim: "The feature defaults to enabled.",
    status: "active",
    provenance: {
      experienceIds: ["experience-a"],
      evidence: [evidence],
      createdBy: "root",
      createdAt: time,
      lastVerifiedAt: time,
      verificationSource: "git-current-state"
    },
    validity: { state: "verified", checkedAt: time, evidence: [evidence] },
    createdAt: time,
    updatedAt: time
  };
  const readContext: MemoryReadContext = {
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    role: "orchestrator",
    taskId: "task-a",
    runId: "run-a",
    agentId: "agent-root",
    canReadGlobal: false
  };
  const hits: readonly MemorySearchHit[] = [
    { memory, score: 1, matchedSignals: ["lexical"] }
  ];
  const repository: MemoryRepository = {
    appendExperience: async () => undefined,
    getExperience: async () => null,
    searchExperiences: async () => [],
    listExperiences: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    listExpiredExperiences: async (
      _request: MemoryExpiredExperienceRequest
    ) => [],
    purgeExperience: async () => "not_visible",
    proposeMemory: async () => undefined,
    getMemory: async () => memory,
    searchMemories: async (_request: MemorySearchRequest) => hits,
    listMemories: async () => ({
      items: [memory],
      total: 1,
      limit: 50,
      offset: 0,
      statusCounts: {
        proposed: 0,
        active: 1,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      }
    }),
    getMemoryHistory: async () => null,
    transitionMemories: async (_changes: readonly MemoryVersionedUpdate[]) =>
      true,
    recordInjectionEvent: async () => ({ appended: false, id: "" }),
    recordOutcomeReport: async () => ({ appended: false, id: "" }),
    findInjectionEventByTokenForSession: async () => null,
    listInjectionOutcomeJoins: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    aggregateInjectionOutcomeCohorts: async (request) => ({
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId!,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells: [],
      exposureCount: 0,
      reportCount: 0
    }),
    recordSessionOutcomeReport: async () => ({ appended: false, id: "" }),
    getSessionOutcomeReport: async () => null,
    aggregateSessionOutcomeCohorts: async (request) => ({
      schema: "autodev-memory-session-outcome-cohorts-v1",
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId!,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells: [],
      sessionCount: 0,
      reportedSessionCount: 0,
      unreportedSessionCount: 0,
      exposureCount: 0,
      conflictingOutcomeSessionCount: 0,
      mixedModeSessionCount: 0
    }),
    getInjectionEventByIdForSession: async () => null,
    recordInjectionUseReport: async () => ({ appended: false, id: "" }),
    getInjectionUseReport: async () => null,
    listInjectionUseJoins: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    aggregateInjectionUseCohorts: async (request) => ({
      schema: "autodev-memory-injection-use-cohorts-v1",
      workspaceId: request.context.workspaceId,
      repositoryId: request.context.repositoryId ?? "",
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells: [],
      exposureCount: 0
    })
  };
  let validationCalls = 0;
  let reconstructionCalls = 0;
  const service = new MemoryService({
    repository,
    verifier: {
      verify: async () => {
        validationCalls += 1;
        return {
          compatibility: "compatible",
          source: "git-current-state",
          checkedAt: time,
          evidence: [evidence],
          reasonCode: "verified_current_state"
        };
      }
    },
    reconstructor: {
      reconstruct: async () => {
        reconstructionCalls += 1;
        return {
          disposition: "retain",
          guidance: "Verify the current feature setting.",
          rationale: "The cited file is unchanged."
        };
      }
    },
    now: () => time
  });
  const context = {
    taskId: "task-a",
    runId: "run-a",
    task: "Update the feature setting.",
    context: readContext
  };

  const payload = { instructions: "Root role instructions." };
  const injected = await injectMemoryContext(service, payload, context);
  assert.notEqual(injected, payload);
  assert.match(
    String(injected.instructions),
    /Verify the current feature setting/
  );
  assert.match(
    String(injected.instructions),
    /file:\/\/\/repo\/src\/feature\.ts/
  );
  assert.equal(validationCalls, 1);
  assert.equal(reconstructionCalls, 1);

  validationCalls = 0;
  reconstructionCalls = 0;
  const retrievedOnly = await injectRetrievalOnlyMemoryContext(
    service,
    payload,
    context
  );
  assert.match(
    String(retrievedOnly.instructions),
    /The feature defaults to enabled/
  );
  assert.match(
    String(retrievedOnly.instructions),
    /Retrieval-only ablation: this claim was not validated/
  );
  assert.match(String(retrievedOnly.instructions), /not_evaluated/);
  assert.doesNotMatch(
    String(retrievedOnly.instructions),
    /Verify the current feature setting/
  );
  assert.equal(validationCalls, 0);
  assert.equal(reconstructionCalls, 0);

  const emptyRepository = { ...repository, searchMemories: async () => [] };
  const emptyService = new MemoryService({
    repository: emptyRepository,
    verifier: {
      verify: async () => {
        throw new Error("no memory should be verified");
      }
    },
    reconstructor: {
      reconstruct: async () => {
        throw new Error("no memory should be reconstructed");
      }
    },
    now: () => time
  });
  const unmodified = { instructions: "Root role instructions." };
  assert.equal(
    await injectMemoryContext(emptyService, unmodified, context),
    unmodified
  );
});
