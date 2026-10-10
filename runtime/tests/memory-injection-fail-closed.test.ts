import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryRecord,
  MemoryReadContext,
  MemoryRepository,
  MemorySearchHit
} from "@simulatorlife/autodev-core";

import type { MemoryRepositoryRootResolver } from "../src/memory/git-curation.ts";
import type { PostgresMemoryHost } from "../src/memory/postgres.ts";
import { MemoryService } from "../src/memory/service.ts";
import {
  clearTrustedMemoryContextsForTest,
  injectOrchestratorMemory,
  type OrchestratorMemoryRequest
} from "../src/router/memory-injection.ts";

/**
 * What the router injection does when it cannot place the workspace, cannot
 * read the payload, or cannot reach memory.
 *
 * Three of these arms had never run, and one of them was untestable rather than
 * merely untested. `injectOrchestratorMemory` hands `createService` a resolver
 * that answers "which directory does this scope mean", and the real host passes
 * it to the git verifier and the skill promoter. The observation suite's host
 * double declared `createService: () => ...` and discarded the argument, so the
 * resolver's body never executed anywhere in the suite: the scoping decision
 * that stands between a memory and somebody else's working tree was written
 * down, commented, and verified by nothing.
 *
 * The double below therefore honours its parameter. The repository asks the
 * resolver for a root the way the verifier does, so the assertions are about
 * the value the curation layer would actually receive, not about a closure
 * invoked by hand.
 */

const REPO_ROOT = "/repo/autodev";
const TIME = "2026-10-01T12:00:00.000Z";
const EVIDENCE = { kind: "file" as const, uri: "file:///repo/src/feature.ts" };
const SESSION = "session-fail-closed";

const DEFAULT_WORKSPACE = {
  key: "SimulatorLife/AutoDev",
  workspace_id: "SimulatorLife/AutoDev",
  cwd: REPO_ROOT
};

/** A second workspace, so a session key can be made to disagree with itself. */
const OTHER_WORKSPACE = {
  key: "SimulatorLife/Other",
  workspace_id: "SimulatorLife/Other",
  cwd: "/repo/other"
};

const ENV_KEYS = [
  "AUTODEV_MEMORY_MODE",
  "AUTODEV_MEMORY_ABLATION",
  "AUTODEV_MEMORY_EXPERIMENT_ID",
  "AUTODEV_MEMORY_READ_GLOBAL"
] as const;

function searchHit(): MemorySearchHit {
  return {
    memory: {
      id: "memory-fail-closed",
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "SimulatorLife/AutoDev"
      },
      claim: "The retry budget lives in config/runtime.yaml.",
      status: "active",
      provenance: {
        experienceIds: ["experience-a"],
        evidence: [EVIDENCE],
        createdBy: "root",
        createdAt: TIME,
        lastVerifiedAt: TIME,
        verificationSource: "git-current-state"
      },
      validity: { state: "verified", checkedAt: TIME, evidence: [EVIDENCE] },
      createdAt: TIME,
      updatedAt: TIME
    } as MemoryRecord,
    score: 1
  } as MemorySearchHit;
}

interface DriveOptions {
  readonly mode?: string;
  readonly experimentId?: string;
  readonly hits?: readonly MemorySearchHit[];
  /** Makes the read fail the way an unreachable database does. */
  readonly failSearch?: boolean;
  readonly request?: Partial<OrchestratorMemoryRequest>;
  readonly workspace?: OrchestratorMemoryRequest["workspace"] | null;
  /**
   * Clears the process-wide trust map before and after, which is what keeps one
   * turn's trust decision out of the next. A test that needs a session to
   * disagree with itself across two turns turns this off and clears after.
   */
  readonly isolated?: boolean;
}

/**
 * Drive one request through the real injection path.
 *
 * `roots` records what the curation layer was told each memory's repository
 * resolves to. `events` records every injection observation the turn produced,
 * which is how "nothing was recorded" is told apart from "it was recorded and
 * the assertion missed it".
 */
async function drive(options: DriveOptions = {}): Promise<{
  readonly result: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly roots: (string | null)[];
  readonly events: unknown[];
  readonly resolver: MemoryRepositoryRootResolver | undefined;
}> {
  const roots: (string | null)[] = [];
  const events: unknown[] = [];
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  let resolver: MemoryRepositoryRootResolver | undefined;

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
    listExpiredExperiences: async () => [],
    purgeExperience: async () => "not_visible",
    proposeMemory: async () => undefined,
    getMemory: async () => null,
    searchMemories: async (search) => {
      if (options.failSearch === true) {
        throw new Error("the memory database is unreachable");
      }
      // What `GitWorkingTreeMemoryVerifier` does with the same resolver: ask for
      // the directory this scope means before trusting a memory against it.
      const hits = options.hits ?? [searchHit()];
      if (hits.length > 0) {
        roots.push(
          (await resolver?.resolve({
            workspaceId: "SimulatorLife/AutoDev",
            repositoryId: "SimulatorLife/AutoDev",
            role: "orchestrator",
            taskId: "task-fail-closed",
            runId: "run-fail-closed",
            canReadGlobal: false
          })) ?? null
        );
      }
      return search.limit === undefined ? hits : hits.slice(0, search.limit);
    },
    listMemories: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      statusCounts: {
        proposed: 0,
        active: 0,
        superseded: 0,
        invalidated: 0,
        uncertain: 0
      }
    }),
    getMemoryHistory: async () => null,
    transitionMemories: async () => true,
    recordInjectionEvent: async (input) => {
      events.push(input);
      return { appended: true, id: input.event.id };
    },
    recordOutcomeReport: async () => ({ appended: false, id: "" }),
    findInjectionEventByTokenForSession: async () => null,
    listInjectionOutcomeJoins: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    aggregateInjectionOutcomeCohorts: async () => ({
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      workspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: TIME,
      occurredUntil: TIME,
      cells: [],
      exposureCount: 0,
      reportCount: 0
    }),
    recordSessionOutcomeReport: async () => ({ appended: false, id: "" }),
    getSessionOutcomeReport: async () => null,
    aggregateSessionOutcomeCohorts: async () => ({
      schema: "autodev-memory-session-outcome-cohorts-v1",
      workspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: TIME,
      occurredUntil: TIME,
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
    aggregateInjectionUseCohorts: async () => ({
      schema: "autodev-memory-injection-use-cohorts-v1",
      workspaceId: "SimulatorLife/AutoDev",
      repositoryId: "SimulatorLife/AutoDev",
      occurredFrom: TIME,
      occurredUntil: TIME,
      cells: [],
      exposureCount: 0
    })
  };

  const host: PostgresMemoryHost = {
    // The parameter is the point of this file: the real host hands it to the
    // verifier and the promoter, so it is captured and used, never dropped.
    createService: (repositories) => {
      resolver = repositories;
      return new MemoryService({
        repository,
        verifier: {
          verify: async () => ({
            compatibility: "compatible",
            source: "git-current-state",
            checkedAt: TIME,
            evidence: [EVIDENCE],
            reasonCode: "verified_current_state"
          })
        },
        reconstructor: {
          reconstruct: async () => ({
            disposition: "retain",
            guidance: "The retry budget lives in config/runtime.yaml.",
            rationale: "The cited file is unchanged."
          })
        }
      });
    },
    probe: async () => "reachable",
    close: async () => undefined
  };

  try {
    for (const key of ENV_KEYS) delete process.env[key];
    if (options.mode !== undefined)
      process.env.AUTODEV_MEMORY_MODE = options.mode;
    if (options.experimentId !== undefined) {
      process.env.AUTODEV_MEMORY_EXPERIMENT_ID = options.experimentId;
    }
    if (options.isolated !== false) clearTrustedMemoryContextsForTest();

    const workspace =
      options.workspace === undefined ? DEFAULT_WORKSPACE : options.workspace;
    const payload = {
      model: "autodev/orchestrator",
      instructions: "Authoritative root policy.",
      input: [
        { type: "message", role: "user", content: "Raise the retry budget." }
      ]
    };
    const result = await injectOrchestratorMemory(
      {
        ...options.request,
        payload: options.request?.payload ?? payload,
        requestId: "request-fail-closed",
        sessionKey: SESSION,
        sessionScope: "identified",
        threadId: "thread-fail-closed",
        workspace
      },
      host
    );
    return { result, payload, roots, events, resolver };
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (options.isolated !== false) clearTrustedMemoryContextsForTest();
  }
}

test("a workspace the router cannot place is handed straight back", async () => {
  // Every one of these is a request that must not be enriched and must not be
  // observed. `!path.isAbsolute(workspace.cwd)` was the one clause no test ever
  // reached: a relative path is the shape a caller reaches by sending `cwd`
  // from a shell working directory rather than from resolved metadata, and it
  // is exactly what must not be resolved against.
  for (const [label, workspace] of [
    ["a relative cwd", { key: "SimulatorLife/AutoDev", cwd: "repo/autodev" }],
    ["an empty cwd", { key: "SimulatorLife/AutoDev", cwd: "" }],
    ["an unknown repository key", { key: "unknown", cwd: REPO_ROOT }],
    ["a blank repository key", { key: "   ", cwd: REPO_ROOT }]
  ] as const) {
    const { result, payload, events } = await drive({ mode: "jit", workspace });
    assert.equal(
      result,
      payload,
      `${label}: the caller's payload object was rebuilt instead of returned as-is`
    );
    assert.doesNotMatch(
      String(result.instructions),
      /AUTODEV MEMORY PACKET/u,
      `${label}: memory was attached to a workspace the router cannot place`
    );
    assert.equal(
      events.length,
      0,
      `${label}: an observation was recorded anyway`
    );
  }
});

test("instructions the router cannot read as text stop the turn before enrichment", async () => {
  // The payload carries whatever the provider accepted. A structured
  // `instructions` is legal on the wire, so this is a shape a real caller can
  // send, and string-concatenating it would put `[object Object]` into the
  // system prompt.
  //
  // Both arms are checked because the enrichment path refuses this shape too
  // (`injectMemoryContext` and `injectRetrievalOnlyMemoryContext` each carry
  // the same check), so under `jit` alone the router's copy is not observable:
  // deleting it changed nothing and the suite stayed green. What the router's
  // copy actually buys is the *skip* path — it runs before the mode is
  // consulted, so without it a turn whose instructions cannot be read would
  // still record an observation describing memory that never ran.
  for (const instructions of [{ text: "policy" }, 42, ["a"], null]) {
    // The payload keeps a user message. Without one the turn stops at
    // `latestUserTask`, which is *before* the mode is consulted, and the guard
    // under test is never reached — the first draft of this fixture did exactly
    // that and passed against a source with the guard deleted.
    const payload = {
      instructions,
      input: [
        { type: "message", role: "user", content: "Raise the retry budget." }
      ]
    };
    const { result, events } = await drive({
      mode: "jit",
      request: { payload }
    });

    assert.equal(
      result.instructions,
      instructions,
      "the unreadable instructions were replaced rather than passed through"
    );
    assert.equal(
      events.length,
      0,
      "an observation was recorded for a turn that never ran"
    );

    const skipped = await drive({
      mode: "disabled",
      request: { payload }
    });
    assert.equal(
      skipped.events.length,
      0,
      "an observation described a skip for a turn whose payload was never read"
    );
  }
});

test("a memory read that fails leaves the caller's turn intact", async () => {
  // "Historical memory is advisory; a database/curation failure must not fail
  // the task." The catch that says so had never been taken, so nothing held the
  // promise: a database outage could have surfaced as a failed model request.
  const { result, payload, events } = await drive({
    mode: "jit",
    failSearch: true
  });

  assert.equal(
    result,
    payload,
    "a failed memory read did not return the caller's own payload"
  );
  assert.doesNotMatch(String(result.instructions), /AUTODEV MEMORY PACKET/u);
  assert.equal(events.length, 0, "a failed read was observed as if it had run");
});

test("the repository resolver answers for this workspace and nothing else", async () => {
  // `MemoryRepositoryRootResolver.resolve` is documented as resolving a
  // repository "from trusted runtime metadata, never a tool argument", and the
  // real host hands it to the verifier that decides whether a memory still
  // matches the tree. So it is a privacy boundary: a root resolved for somebody
  // else's scope would have memories verified against the wrong working tree.
  const { roots } = await drive({ mode: "jit" });

  assert.deepEqual(
    roots,
    [REPO_ROOT],
    "the curation layer was not given this workspace's own root for its own scope"
  );
});

test("a scope naming another workspace resolves to no root at all", async () => {
  // The refusal half, which is the half that matters. Returning *some* root
  // here would verify memories against an arbitrary tree rather than refusing
  // to verify them at all, and it is the failure a test that only checks the
  // happy path would never see.
  const { resolver } = await drive({ mode: "jit" });
  assert.ok(
    resolver,
    "the host was never given a resolver to refuse anything with"
  );

  const scope = (over: Partial<MemoryReadContext>): MemoryReadContext => ({
    workspaceId: "SimulatorLife/AutoDev",
    repositoryId: "SimulatorLife/AutoDev",
    role: "orchestrator",
    taskId: "task-fail-closed",
    runId: "run-fail-closed",
    canReadGlobal: false,
    ...over
  });

  assert.equal(
    await resolver.resolve(scope({})),
    REPO_ROOT,
    "precondition: the request's own scope did not resolve to its own root"
  );
  assert.equal(
    await resolver.resolve(scope({ workspaceId: "other/workspace" })),
    null,
    "another workspace's scope was given a repository root"
  );
  assert.equal(
    await resolver.resolve(scope({ repositoryId: "other/repository" })),
    null,
    "another repository in the same workspace was given a root"
  );
});

test("an experiment records no skip for a session it cannot attribute", async () => {
  // Outside an experiment an untrusted session still produces a skip: the
  // observation is about the request, not about a person. Inside one it must
  // not, because the cohort is built by counting sessions and a skip attributed
  // to a session the router revoked would put a conflicted session in an arm.
  //
  // "Untrusted" has to mean the revoked case, not a session the router has never
  // seen. `isTrustedSession` grants trust on first observation — that is the
  // whole point of the call that registers the session — so a brand-new key is
  // trusted, and a fixture built from one would have passed for the wrong
  // reason. A session is untrusted once it has been seen somewhere else: the
  // second registration conflicts, the router writes `null`, and from then on
  // the key is nobody's.
  //
  // Both halves run so that "nothing was recorded" cannot be satisfied by a
  // path that records nothing at all.
  const first = await drive({
    mode: "disabled",
    experimentId: "experiment-fail-closed",
    workspace: DEFAULT_WORKSPACE,
    isolated: false
  });
  assert.equal(
    first.events.length,
    1,
    "the control recorded no skip, so the refusal below would be vacuous"
  );

  const conflicted = await drive({
    mode: "disabled",
    experimentId: "experiment-fail-closed",
    workspace: OTHER_WORKSPACE,
    isolated: false
  });
  assert.equal(
    conflicted.events.length,
    0,
    "an experiment attributed a skip to a session the router had revoked"
  );
  clearTrustedMemoryContextsForTest();
});

test("an unplaceable workspace is recorded no skip either", async () => {
  // The same rule for the workspace half, and it applies outside an experiment:
  // there is no repository to attribute the observation to, so there is nothing
  // to record it against.
  //
  // This is a conjunction, and it is honest about being one. `injectOrchestratorMemory`
  // refuses an unplaceable workspace itself and returns before the mode is
  // consulted, so the identical check inside `skipSessionContextForRequest` never
  // runs — that copy is masked by the caller's, and removing either one alone
  // leaves this test green. The outcome is what matters and the caller is what
  // enforces it; both copies exist because the helper takes a request and must
  // not trust the caller to have checked.
  const unplaceable = await drive({
    mode: "disabled",
    workspace: { key: "SimulatorLife/AutoDev", cwd: "relative/path" }
  });
  assert.equal(
    unplaceable.events.length,
    0,
    "a skip was recorded with no repository"
  );

  const placeable = await drive({ mode: "disabled" });
  assert.equal(
    placeable.events.length,
    1,
    "the control produced no skip either, so the assertion above was vacuous"
  );
});
