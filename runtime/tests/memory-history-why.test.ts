import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryHistory,
  MemoryReadContext,
  MemoryRecord,
  MemoryRepository
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { MemoryService as MemoryServiceClass } from "../src/memory/service.ts";

/**
 * `history` and `why` are the two read paths with no Runtime test.
 *
 * Both re-check scope visibility on top of what the repository already scoped,
 * and neither re-check had a failing test. The obvious way to write one --
 * give the service an invisible memory and assert it returns null -- proves
 * nothing, because the repository refuses the same memory first and returns
 * null either way. Deleting the service's re-check would not change a single
 * assertion.
 *
 * So the repository below is stubbed to hand back rows it should have scoped
 * out. That is the only situation the re-check exists for: a repository whose
 * SQL scope filter has drifted from `isMemoryScopeVisibleTo`. With an honest
 * repository the two layers always agree, and the second one is untestable.
 */
interface StubRepository {
  readonly repository: MemoryRepository;
  readonly experienceLookups: string[];
}

function stubRepository(options: {
  readonly history: MemoryHistory | null;
  readonly experiences: Readonly<Record<string, ExperienceEnvelope>>;
}): StubRepository {
  const experienceLookups: string[] = [];
  // Cast rather than implement all forty methods: this test is about the two
  // reads above, and a stub for the rest would be forty lines that never run.
  const repository = {
    getMemoryHistory: async () => options.history,
    getExperience: async (id: string) => {
      experienceLookups.push(id);
      return options.experiences[id] ?? null;
    }
  } as unknown as MemoryRepository;
  return { repository, experienceLookups };
}

function serviceFor(stub: StubRepository): MemoryService {
  return new MemoryServiceClass({
    repository: stub.repository,
    // `history` and `why` read and never validate or reconstruct. Both are still
    // required by the options type, so these fail loudly rather than answer --
    // a test that accidentally reached for validation would then fail instead
    // of quietly measuring the wrong thing.
    verifier: {
      verify: async () => {
        throw new Error("reading history must not validate current state");
      }
    },
    reconstructor: {
      reconstruct: async () => {
        throw new Error("reading history must not reconstruct");
      }
    }
  } as ConstructorParameters<typeof MemoryServiceClass>[0]);
}

const workspaceContext: MemoryReadContext = {
  workspaceId: "ws-1",
  canReadGlobal: false
};

const repositoryContext: MemoryReadContext = {
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  canReadGlobal: false
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    scope: { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
    kind: "semantic",
    claim: "The retry budget lives in config/runtime.json.",
    content: "The retry budget lives in config/runtime.json.",
    status: "active",
    confidence: 0.8,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    validity: {
      state: "verified",
      checkedAt: "2026-10-02T10:00:00.000Z",
      verificationSource: "git_github_pr_supersession",
      evidence: []
    },
    provenance: {
      experienceIds: ["exp-1", "exp-hidden", "exp-2"],
      createdBy: "agent-1",
      createdAt: "2026-10-01T10:05:00.000Z"
    },
    ...overrides
  } as MemoryRecord;
}

function history(overrides: Partial<MemoryHistory> = {}): MemoryHistory {
  return {
    memory: record(),
    lineage: [],
    events: [],
    ...overrides
  } as MemoryHistory;
}

function experience(
  id: string,
  overrides: Partial<ExperienceEnvelope> = {}
): ExperienceEnvelope {
  return {
    id,
    workspaceId: "ws-1",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    startedAt: "2026-10-01T09:00:00.000Z",
    outcome: "success",
    trajectory: { format: "codex-v1", uri: `trajectory://${id}` },
    evidence: [],
    ...overrides
  } as ExperienceEnvelope;
}

test("history re-checks scope visibility even when the repository returned one", async () => {
  const repositoryScoped = history();
  const stub = stubRepository({ history: repositoryScoped, experiences: {} });
  const service = serviceFor(stub);

  // Positive control first. A repository-only scope is invisible to a
  // workspace-only context, and asserting that first is what makes the null
  // below mean "the re-check refused it" rather than "everything is null".
  assert.equal(
    await service.history("mem-1", repositoryContext),
    repositoryScoped,
    "the owning repository must resolve its own memory"
  );
  assert.equal(
    await service.history("mem-1", workspaceContext),
    null,
    "a memory scoped to repo-1 must not be readable from a workspace-only context, even when the repository hands it back"
  );
});

test("history withholds a global-scoped memory from a context that cannot read global", async () => {
  const globalHistory = history({
    memory: record({ scope: { kind: "global" } })
  });
  const stub = stubRepository({ history: globalHistory, experiences: {} });
  const service = serviceFor(stub);

  assert.equal(
    await service.history("mem-1", {
      ...workspaceContext,
      canReadGlobal: false
    }),
    null,
    "global provenance is not readable without the grant"
  );
  assert.equal(
    await service.history("mem-1", {
      ...workspaceContext,
      canReadGlobal: true
    }),
    globalHistory,
    "the same memory is readable once the grant is present"
  );
});

test("why refuses an unreadable memory without fetching its source experiences", async () => {
  const stub = stubRepository({
    history: history(),
    experiences: {
      "exp-1": experience("exp-1"),
      "exp-2": experience("exp-2")
    }
  });
  const service = serviceFor(stub);

  assert.equal(
    await service.why("mem-1", workspaceContext),
    null,
    "an invisible memory has no explanation to give"
  );
  assert.deepEqual(
    stub.experienceLookups,
    [],
    "the refusal must happen before any source experience is read, or the provenance is fetched for a caller who cannot see the memory"
  );
});

test("why returns the readable source experiences in provenance order", async () => {
  const stub = stubRepository({
    history: history(),
    experiences: {
      "exp-1": experience("exp-1"),
      // Scoped to another workspace: readable by nothing here. The repository
      // is stubbed to hand it over regardless, which is the point.
      "exp-hidden": experience("exp-hidden", {
        workspaceId: "ws-2",
        scope: { kind: "workspace", workspaceId: "ws-2" }
      }),
      "exp-2": experience("exp-2")
    }
  });
  const service = serviceFor(stub);

  const why = await service.why("mem-1", repositoryContext);

  assert.ok(why, "a readable memory must have an explanation");
  assert.deepEqual(
    why.sourceExperiences.map(({ id }) => id),
    ["exp-1", "exp-2"],
    "an unreadable source experience is dropped rather than returned, and the rest keep their provenance order"
  );
  assert.deepEqual(
    stub.experienceLookups,
    ["exp-1", "exp-hidden", "exp-2"],
    "every cited experience is attempted, so a gap in the evidence is visible as a missing source rather than as a shorter lineage"
  );
  assert.equal(
    why.memory.id,
    "mem-1",
    "why extends the history it was built from"
  );
});

test("why returns null when the repository has no history for the memory", async () => {
  const stub = stubRepository({ history: null, experiences: {} });
  const service = serviceFor(stub);

  assert.equal(await service.why("mem-missing", repositoryContext), null);
  assert.deepEqual(stub.experienceLookups, []);
});
