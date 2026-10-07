import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryRecord,
  MemoryReadContext,
  MemoryRepository,
  MemorySearchHit
} from "@simulatorlife/autodev-core";

import {
  clearTrustedMemoryContextsForTest,
  injectOrchestratorMemory,
  type OrchestratorMemoryRequest
} from "../src/router/memory-injection.ts";
import type { PostgresMemoryHost } from "../src/memory/postgres.ts";
import { MemoryService } from "../src/memory/service.ts";

/**
 * The injection observation — the record every outcome and use cohort is built
 * on — had never run in a test.
 *
 * The one existing caller passes a `null` host, which returns at the availability
 * check, so `emitInjectionObservation` was never entered. The other suite's
 * service double answers `recordInjectionEvent` with `{ appended: false }` and
 * discards the event, so even a run would have proved nothing. An entire
 * 113-line function sat uncovered behind a stub that swallowed its output.
 *
 * This matters more than an ordinary coverage number. `injectionResult` is what
 * separates a packet the model actually received from one research returned and
 * nothing was attached, and `reasonCode` is what a cohort later groups by. A
 * misclassification here does not fail loudly; it quietly reweights the
 * evaluation the whole memory product rests on.
 *
 * The host is injected through `injectOrchestratorMemory`'s existing
 * `hostOverride` seam, so this exercises the real service and the real
 * enrichment path with only the repository doubled.
 */

const REPO_ROOT = "/repo/autodev";
const SESSION = "session-observation";

/** A repository that records what it was asked to record, and nothing else. */
function capturingRepository(
  captured: MemoryRecordInjectionCapture[],
  hits: readonly MemorySearchHit[] = [],
  options: { readonly failRecord?: boolean } = {}
): MemoryRepository {
  return {
    appendExperience: async () => undefined,
    getExperience: async () => null,
    searchExperiences: async () => [],
    listExperiences: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    listExpiredExperiences: async () => [],
    purgeExperience: async () => "not_visible",
    proposeMemory: async () => undefined,
    getMemory: async () => null,
    searchMemories: async (request) =>
      request.limit === undefined ? hits : hits.slice(0, request.limit),
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
      if (options.failRecord === true) {
        throw new Error("the observation store is unavailable");
      }
      captured.push(input);
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

/** The narrow slice of the record input these assertions read. */
interface MemoryRecordInjectionCapture {
  readonly event: {
    readonly id: string;
    readonly correlationToken: string;
    readonly memoryMode: string;
    readonly injectionResult: string;
    readonly reasonCode: string;
    readonly packetCharacterCount: number;
    readonly memoryIds: readonly string[];
    readonly agentRole?: string;
  };
  readonly actor: { readonly id: string; readonly authority: string };
  readonly context: MemoryReadContext;
}

const TIME = "2026-10-01T12:00:00.000Z";
const EVIDENCE = { kind: "file" as const, uri: "file:///repo/src/feature.ts" };

function searchHit(): MemorySearchHit {
  return {
    memory: {
      id: "memory-observed",
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

function hostFor(repository: MemoryRepository): PostgresMemoryHost {
  return {
    createService: () =>
      new MemoryService({
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
          // One reconstructed entry per retrieved memory, not a list: this is
          // what the JIT arm turns into the packet body the observation reads
          // its cited ids back out of.
          reconstruct: async () => ({
            disposition: "retain",
            guidance: "The retry budget lives in config/runtime.yaml.",
            rationale: "The cited file is unchanged."
          })
        }
      }),
    probe: async () => "reachable",
    close: async () => undefined
  };
}

function request(
  overrides: Partial<OrchestratorMemoryRequest> = {}
): OrchestratorMemoryRequest {
  return {
    payload: {
      model: "autodev/orchestrator",
      instructions: "Authoritative root policy.",
      input: [{ type: "message", role: "user", content: "Raise the retry budget." }]
    },
    requestId: "request-observation",
    sessionKey: SESSION,
    sessionScope: "identified",
    threadId: "thread-observation",
    workspace: {
      key: "SimulatorLife/AutoDev",
      workspace_id: "SimulatorLife/AutoDev",
      cwd: REPO_ROOT
    },
    ...overrides
  };
}

const ENV_KEYS = [
  "AUTODEV_MEMORY_MODE",
  "AUTODEV_MEMORY_ABLATION",
  "AUTODEV_MEMORY_EXPERIMENT_ID",
  "AUTODEV_MEMORY_READ_GLOBAL"
] as const;

/**
 * Drive one request through the real router injection path and return what the
 * observation store was told.
 *
 * `clearTrustedMemoryContextsForTest` runs first because the router caches the
 * session/workspace pairing process-wide; without it a later test would inherit
 * a trust decision made by an earlier one.
 */
async function observe(options: {
  readonly mode: string;
  readonly hits?: readonly MemorySearchHit[];
  readonly failRecord?: boolean;
  readonly overrides?: Partial<OrchestratorMemoryRequest>;
  readonly instructions?: string;
  readonly ablation?: boolean;
}): Promise<{
  readonly events: MemoryRecordInjectionCapture[];
  readonly payload: Record<string, unknown>;
}> {
  const captured: MemoryRecordInjectionCapture[] = [];
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AUTODEV_MEMORY_MODE = options.mode;
    if (options.ablation === true) process.env.AUTODEV_MEMORY_ABLATION = "1";
    clearTrustedMemoryContextsForTest();
    const payload =
      options.instructions === undefined
        ? request(options.overrides).payload
        : {
            ...request(options.overrides).payload,
            instructions: options.instructions
          };
    const result = await injectOrchestratorMemory(
      { ...request(options.overrides), payload },
      hostFor(
        capturingRepository(captured, options.hits, {
          failRecord: options.failRecord === true
        })
      )
    );
    return { events: captured, payload: result };
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearTrustedMemoryContextsForTest();
  }
}

/**
 * The one observation a turn must produce.
 *
 * Asserting the length and handing back the element in one place keeps
 * `noUncheckedIndexedAccess` honest — `events[0]` is `T | undefined`, and a
 * test that reads it directly is a test that would throw rather than fail if
 * the emission ever stopped.
 */
function only(
  events: readonly MemoryRecordInjectionCapture[]
): MemoryRecordInjectionCapture["event"] {
  assert.equal(events.length, 1, "exactly one observation for this turn");
  const captured = events.at(0);
  assert.ok(captured !== undefined, "the observation exists");
  return captured.event;
}

test("a packet the model actually received is recorded as injected, with the ids it cited", async () => {
  const { events } = await observe({ mode: "jit", hits: [searchHit()] });
  const event = only(events);

  assert.equal(event.injectionResult, "injected");
  assert.equal(event.reasonCode, "packet_attached");
  assert.ok(
    event.packetCharacterCount > 0,
    "an injected packet whose length was not measured"
  );
  // The ids are read back out of the packet body, so a cohort can join a use
  // report to the claims the model was actually shown.
  assert.deepEqual([...event.memoryIds], ["memory-observed"]);
  assert.equal(event.memoryMode, "jit");
  // The runtime writes its own observations under the system authority, never
  // under the operator's: an injection event is something that happened, not
  // something a person reported.
  assert.equal(events.at(0)?.actor.authority, "system");
});

test("research that returned nothing is recorded as empty, not as a skip", async () => {
  // The distinction the whole evaluation rests on: a packet was built and came
  // back empty is a different observation from one that was never attempted.
  const event = only((await observe({ mode: "jit", hits: [] })).events);

  assert.equal(event.injectionResult, "empty");
  assert.equal(event.reasonCode, "no_packet_research_returned_empty");
  assert.equal(event.packetCharacterCount, 0);
  assert.deepEqual([...event.memoryIds], []);
});

test("the retrieval-only arm records an empty research result the same way", async () => {
  // `retrieval-only` is only a real mode behind the ablation flag, so the flag
  // is set here rather than assumed.
  const event = only(
    (await observe({ mode: "retrieval-only", ablation: true, hits: [] })).events
  );

  assert.equal(event.injectionResult, "empty");
  assert.equal(event.memoryMode, "retrieval-only");
});

test("the retrieval-only arm is refused without the ablation gate", async () => {
  // Fail-closed, and worth stating because it is silent: naming the arm
  // without the flag does not run the arm and does not fall back to jit, it
  // becomes `invalid` and is recorded as a skip. An operator who typed the mode
  // would otherwise see "retrieval-only" in their config and a skip in the data.
  const event = only((await observe({ mode: "retrieval-only", hits: [] })).events);

  assert.equal(event.injectionResult, "skipped");
  assert.equal(event.reasonCode, "memory_mode_invalid");
  assert.equal(event.memoryMode, "invalid");
});

test("packet markers already in the base instructions are never credited as this turn's injection", async () => {
  // The guarantee is real but the mechanism is not the extractor's: the
  // enrichment strips every existing packet marker before the observation
  // reads the instructions, so a stale packet, a reversed marker pair, or
  // policy text quoting the markers all end up with nothing to find.
  //
  // My first drafts of this asserted that `extractMemoryPacketBlock` rejects
  // each shape, and a mutation of its marker-ordering check left both of them
  // green — because the extractor never saw those markers at all. The property
  // worth pinning is the end-to-end one: nothing the caller put in its own
  // instructions is ever recorded as memory the model received.
  for (const [label, instructions] of [
    ["an unterminated marker", "Authoritative root policy.\n--- AUTODEV MEMORY PACKET V1 ---\nquoted example only"],
    [
      "a reversed marker pair",
      "--- END AUTODEV MEMORY PACKET ---\npolicy quoting a closed packet\n--- AUTODEV MEMORY PACKET V1 ---"
    ],
    [
      "a complete stale packet",
      "--- AUTODEV MEMORY PACKET V1 ---\n{\"memoryId\":\"memory-not-really-injected\"}\n--- END AUTODEV MEMORY PACKET ---"
    ]
  ] as const) {
    const { events, payload } = await observe({ mode: "jit", hits: [], instructions });

    const event = only(events);
    assert.equal(
      event.injectionResult,
      "empty",
      `${label}: must not read as an injection`
    );
    assert.deepEqual(
      [...event.memoryIds],
      [],
      `${label}: cited no ids, because nothing was injected`
    );
    // The *start* marker is what the stripper removes, and it removes it by
    // slicing from the start marker forward -- so an orphan end marker is left
    // behind in the reversed case. That is harmless rather than tidy: nothing
    // downstream looks for an end marker before a start, and the extractor
    // requires the start, which is gone.
    assert.doesNotMatch(
      String(payload.instructions),
      /AUTODEV MEMORY PACKET V1/u,
      `${label}: the start marker must be stripped from what the caller receives`
    );
  }
});

test("a disabled mode records a skip under its own reason code", async () => {
  const { events, payload } = await observe({ mode: "disabled", hits: [searchHit()] });
  const event = only(events);

  assert.equal(event.injectionResult, "skipped");
  assert.equal(event.reasonCode, "memory_mode_disabled");
  assert.equal(event.memoryMode, "disabled");
  assert.equal(event.packetCharacterCount, 0);
  // A disabled arm must not change what the caller receives either.
  assert.match(String(payload.instructions), /Authoritative root policy/u);
  assert.doesNotMatch(String(payload.instructions), /AUTODEV MEMORY PACKET/u);
});

test("an unparseable mode records a skip under the invalid reason code", async () => {
  const event = only((await observe({ mode: "not-a-real-mode", hits: [] })).events);

  assert.equal(event.injectionResult, "skipped");
  assert.equal(event.reasonCode, "memory_mode_invalid");
  assert.equal(event.memoryMode, "invalid");
});

test("the observation carries no packet or claim text", async () => {
  const serialised = JSON.stringify(
    only((await observe({ mode: "jit", hits: [searchHit()] })).events)
  );
  assert.doesNotMatch(serialised, /retry budget/u, "the claim leaked into the event");
  assert.doesNotMatch(serialised, /feature\.ts/u, "an evidence URI leaked into the event");
  assert.doesNotMatch(
    serialised,
    /Raise the retry budget/u,
    "the user's task leaked into the event"
  );
});

test("a store that cannot record the observation still returns the enriched turn", async () => {
  // Best-effort by design: the observation is telemetry about the request, and
  // losing it must never fail the task it describes.
  const { events, payload } = await observe({
    mode: "jit",
    hits: [searchHit()],
    failRecord: true
  });

  assert.equal(events.length, 0, "nothing was stored, as expected");
  assert.match(
    String(payload.instructions),
    /AUTODEV MEMORY PACKET/u,
    "the packet still reaches the caller when the observation cannot be stored"
  );
});