import assert from "node:assert/strict";
import test from "node:test";

import type {
  EvidenceReference,
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

test("a task exactly at the bound passes through, and one character past it truncates", () => {
  // The task this module carries is bounded far higher than the query bound, so
  // every task either passes through unchanged or is truncated -- and the
  // pass-through branch is the one that can emit an over-length query, because
  // nothing clamps it afterwards. That branch is exactly what drifted before the
  // two bounds became one constant.
  //
  // The lengths are written out rather than read from the shared constant on
  // purpose. Taking them from the constant would make this pass for any value
  // it is given, which is the one property here not worth checking.
  assert.equal(
    memoryQueryFromTask("a".repeat(4000)).length,
    4000,
    "a task at the bound is already a valid query and must not be truncated"
  );
  assert.equal(
    memoryQueryFromTask("a".repeat(4001)).length,
    4000,
    "a task one character past the bound must be truncated, not passed through"
  );
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

/**
 * A repository whose only interesting behaviour is the hits `search` returns.
 *
 * Extracted from the JIT test that first needed it: the injection path's bounds
 * need several different hit sets, and ninety duplicated lines per fixture would
 * make the bounds -- the part worth reviewing -- the part nobody reads twice.
 */
function memoryRepository(
  hits: readonly MemorySearchHit[],
  memory: MemoryRecord | null = null
): MemoryRepository {
  return {
    appendExperience: async () => undefined,
    getExperience: async () => null,
    searchExperiences: async () => [],
    listExperiences: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    listExpiredExperiences: async () => [],
    purgeExperience: async () => "not_visible",
    proposeMemory: async () => undefined,
    getMemory: async () => memory,
    // A real repository honours the limit, and so must this one: without the
    // slice, raising the ablation's search limit would change nothing here and
    // the limit would read as enforced while never being applied.
    searchMemories: async (request) =>
      request.limit === undefined ? hits : hits.slice(0, request.limit),
    listMemories: async () => ({
      items: memory === null ? [] : [memory],
      total: memory === null ? 0 : 1,
      limit: 50,
      offset: 0,
      statusCounts: {
        proposed: 0,
        active: memory === null ? 0 : 1,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      }
    }),
    getMemoryHistory: async () => null,
    transitionMemories: async () => true,
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
      repositoryId: request.context.repositoryId ?? "",
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
      repositoryId: request.context.repositoryId ?? "",
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
}

const ABLATION_TIME = "2026-09-30T12:00:00.000Z";

/** One eligible hit, so only the bound under test can refuse it. */
function ablationHit(overrides: Partial<MemoryRecord> = {}): MemorySearchHit {
  const evidence = {
    kind: "file" as const,
    uri: "file:///repo/src/feature.ts"
  };
  return {
    memory: {
      id: "memory-ablation",
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
        createdAt: ABLATION_TIME,
        lastVerifiedAt: ABLATION_TIME,
        verificationSource: "git-current-state"
      },
      validity: {
        state: "verified",
        checkedAt: ABLATION_TIME,
        evidence: [evidence]
      },
      createdAt: ABLATION_TIME,
      updatedAt: ABLATION_TIME,
      ...overrides
    },
    score: 1,
    matchedSignals: ["lexical"]
  };
}

function ablationService(hits: readonly MemorySearchHit[]): MemoryService {
  return new MemoryService({
    repository: memoryRepository(hits),
    now: () => ABLATION_TIME,
    // The ablation reads through `search` and never validates or reconstructs.
    // Both are still required by the options type, so they are stubs that would
    // fail loudly rather than answer -- a test that accidentally reaches for
    // validation would then fail instead of quietly measuring the wrong thing.
    verifier: {
      verify: async () => {
        throw new Error("the ablation must not validate current state");
      }
    },
    reconstructor: {
      reconstruct: async () => {
        throw new Error("the ablation must not reconstruct guidance");
      }
    }
  });
}

const ABLATION_CONTEXT = {
  taskId: "task-a",
  runId: "run-a",
  task: "Update the feature setting.",
  context: {
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    role: "orchestrator",
    taskId: "task-a",
    runId: "run-a",
    agentId: "agent-root",
    canReadGlobal: false
  } satisfies MemoryReadContext
};

test("the ablation packet is bounded by characters, not only by how many it retrieved", async () => {
  // The ablation deliberately skips current-state validation, so its bounds are
  // the only things standing between a caller and a packet of unvalidated claims.
  // Two hits is exactly what the search limit allows back, so if the second is
  // missing it is the character bound that dropped it -- and that bound is what
  // keeps a handful of long claims from becoming an unbounded payload.
  const service = ablationService([
    ablationHit({ id: "first", claim: `FIRST-LONG-CLAIM-${"a".repeat(2500)}` }),
    ablationHit({
      id: "second",
      claim: `SECOND-LONG-CLAIM-${"b".repeat(2500)}`
    }),
    ablationHit({ id: "third", claim: "THIRD-CLAIM-never-retrieved" })
  ]);

  const injected = await injectRetrievalOnlyMemoryContext(
    service,
    { instructions: "Root role instructions." },
    ABLATION_CONTEXT
  );
  const text = String(injected.instructions);

  assert.match(
    text,
    /FIRST-LONG-CLAIM/u,
    "the first entry fits and must be kept"
  );
  assert.doesNotMatch(
    text,
    /SECOND-LONG-CLAIM/u,
    "the second pushes the packet past the character bound"
  );
  assert.doesNotMatch(
    text,
    /THIRD-CLAIM/u,
    "the ablation retrieves only what its search limit allows, whatever fits"
  );
  // Only the entries are asserted, because only the entries are rendered:
  // `appendMemoryPacket` stringifies `packet.entries` and nothing else, so
  // `omittedCount` never reaches the caller. Whether that is right is a product
  // question about telling a model its memory was truncated; it is not a
  // property of the bound this test is about.
});

test("the ablation packet bounds what each entry may carry", async () => {
  // Two independent bounds on operator-supplied locator text: how many, and how
  // long. They are tested separately because one can hide the other -- a cap on
  // count alone leaves an over-long locator in, and a length filter alone leaves
  // an unbounded list of short ones in.
  const short = (name: string): EvidenceReference => ({
    kind: "file",
    uri: `file:///repo/src/${name}.ts`
  });
  const service = ablationService([
    ablationHit({
      id: "count-capped",
      provenance: {
        experienceIds: ["experience-a"],
        evidence: [1, 2, 3, 4, 5].map((n) => short(`locator-${n}`)),
        createdBy: "root",
        createdAt: ABLATION_TIME
      }
    }),
    ablationHit({
      id: "length-capped",
      provenance: {
        experienceIds: ["experience-a"],
        evidence: [
          {
            kind: "file" as const,
            uri: `file:///repo/src/${"u".repeat(600)}.ts`
          },
          {
            kind: "commit" as const,
            uri: "git://repo/short",
            revision: "r".repeat(200)
          },
          short("kept")
        ],
        createdBy: "root",
        createdAt: ABLATION_TIME
      }
    })
  ]);

  const injected = await injectRetrievalOnlyMemoryContext(
    service,
    { instructions: "Root role instructions." },
    ABLATION_CONTEXT
  );
  const text = String(injected.instructions);

  assert.match(
    text,
    /The feature defaults to enabled\./u,
    "the claims still reach the caller"
  );
  // How many: the fifth locator is past the cap.
  assert.match(text, /locator-4\.ts/u);
  assert.doesNotMatch(text, /locator-5\.ts/u);
  // How long: an over-long URI or revision is not evidence of anything.
  assert.match(text, /kept\.ts/u, "a locator within every bound survives");
  assert.doesNotMatch(text, /uuuu/u);
  assert.doesNotMatch(text, /rrrr/u);
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
  const repository = memoryRepository(hits, memory);
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

test("a task at the text bound is truncated to a query research will accept", async () => {
  // The chain this pins: `memoryQueryFromTask` truncates a task down to the
  // service's query bound, and `research` refuses anything longer than that
  // bound. Nothing between them catches, so a query bound that drifted apart
  // from the accepting bound would reject right here.
  //
  // Worth a test of its own because the router answers that rejection by
  // returning the request unenriched: the failure would be memory silently
  // never being injected for long tasks, with no error anywhere to notice.
  //
  // The task is the longest this module will carry, so the truncation path is
  // the one exercised rather than a short task passed through untouched.
  const service = new MemoryService({
    repository: memoryRepository([]),
    verifier: {
      verify: async () => {
        throw new Error("an empty result has nothing to verify");
      }
    },
    reconstructor: {
      reconstruct: async () => {
        throw new Error("an empty result has nothing to reconstruct");
      }
    },
    now: () => "2026-09-30T12:00:00.000Z"
  });
  const payload = { instructions: "Root role instructions." };
  const longTask = `BEGIN ${"a".repeat(15_900)} FINAL_CONSTRAINT`;

  const injected = await injectMemoryContext(service, payload, {
    taskId: "task-long",
    runId: "run-long",
    task: longTask,
    context: {
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      role: "orchestrator",
      taskId: "task-long",
      runId: "run-long",
      agentId: "agent-root",
      canReadGlobal: false
    }
  });

  // With no hits the packet is empty, so the payload comes back as it went in.
  // Identity, not equality: the point is that research ran to completion, and a
  // rejected query would have thrown instead of returning anything at all.
  assert.equal(injected, payload);
  assert.ok(
    longTask.length > 4000,
    "the task must actually be over the query bound for this to test truncation"
  );
});
