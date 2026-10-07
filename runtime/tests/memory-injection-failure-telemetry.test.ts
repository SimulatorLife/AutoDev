import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContextManager,
  ROOT_CONTEXT,
  type Span,
  context,
  trace
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import type { MemoryRepository } from "@simulatorlife/autodev-core";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryValidationError
} from "@simulatorlife/autodev-runtime/memory";

import {
  clearTrustedMemoryContextsForTest,
  injectOrchestratorMemory,
  type OrchestratorMemoryRequest
} from "../src/router/memory-injection.ts";
import { MemoryService } from "../src/memory/service.ts";
import type { PostgresMemoryHost } from "../src/memory/postgres.ts";

/**
 * The failure classification on a failed injection observation, and the promise
 * it makes about telemetry.
 *
 * When `recordInjectionEvent` throws, `emitInjectionObservation` records a
 * `memory_injection_emit_failed` event carrying one attribute: a bounded,
 * fixed-category `autodev.memory.error.type`. The four-way classification had no
 * test, so the property that makes it safe was stated in a comment and held by
 * nothing — and that property is a privacy boundary, not a convenience.
 *
 * The comment says: "The raw error message/string is never serialized into
 * telemetry: it may contain SQL text, connection details, or other free-form
 * sensitive data." A driver error from a failed insert routinely carries the
 * constraint name and the failing values. Classifying by `error.message` instead
 * of by the error's own type would put all of that into every exported span.
 * That is the kind of change that reads as an improvement and is a disclosure
 * bug, which is why the test asserts the *absence* of the message rather than
 * only the presence of the category.
 *
 * Getting an active span at all took some doing. This package has no
 * `@opentelemetry/context-async-hooks`, so the API's default context manager is a
 * no-op stack and `getActiveSpan()` is always undefined — which is why span
 * export has never been observable here. Rather than leave that arm untested,
 * the file registers a context manager that keeps one span active for its
 * duration. That is the production situation during a routed chat, where the
 * router has a span open, and it does not test OTel's own context propagation.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)]
});
trace.setGlobalTracerProvider(provider);

let activeSpan: Span | undefined;
const stickySpanManager: ContextManager = {
  active: () => (activeSpan ? trace.setSpan(ROOT_CONTEXT, activeSpan) : ROOT_CONTEXT),
  // The real manager restores the previous context around the call. Here the
  // span is meant to outlive the call — that is the point — so `with` is
  // transparent and `active` reports whatever `activeSpan` currently is.
  with: (_scope, fn, thisArg, ...args) => fn.call(thisArg, ...args),
  bind: (_scope, target) => target,
  // `enable`/`disable` return the manager itself, not a context.
  enable: () => stickySpanManager,
  disable: () => stickySpanManager
};
context.setGlobalContextManager(stickySpanManager);

/**
 * Run one injection with a store that fails the way `throwable` says, and return
 * the events it added to the active span.
 */
async function observeFailure(throwable: () => Error): Promise<
  readonly { readonly name: string; readonly attributes: Record<string, unknown> }[]
> {
  const repository = {
    appendExperience: async () => undefined,
    getExperience: async () => null,
    searchExperiences: async () => [],
    listExperiences: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    listExpiredExperiences: async () => [],
    purgeExperience: async () => "not_visible",
    proposeMemory: async () => undefined,
    getMemory: async () => null,
    searchMemories: async () => [],
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
    // The one call that matters here. Everything above is the surface the
    // injection path touches on its way to the store.
    recordInjectionEvent: async () => {
      throw throwable();
    },
    recordOutcomeReport: async () => ({ appended: false, id: "" }),
    findInjectionEventByTokenForSession: async () => null,
    listInjectionOutcomeJoins: async () => ({
      items: [],
      total: 0,
      limit: 50,
      offset: 0
    }),
    aggregateInjectionOutcomeCohorts: async () => ({ items: [], total: 0 }),
    listInjectionUseJoins: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    aggregateInjectionUseCohorts: async () => ({ items: [], total: 0 }),
    getSessionOutcomeReport: async () => null,
    listSessionOutcomeJoins: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    aggregateSessionOutcomeCohorts: async () => ({ items: [], total: 0 }),
    purgeExpiredExperiences: async () => ({
      selected: 0,
      purged: 0,
      referencedByMemory: 0,
      noLongerVisible: 0
    }),
    promoteSkill: async () => {
      throw new Error("not used");
    }
  } as unknown as MemoryRepository;

  const host: PostgresMemoryHost = {
    createService: () =>
      new MemoryService({
        repository,
        verifier: {
          verify: async () => ({
            compatibility: "compatible",
            source: "git-current-state",
            checkedAt: "2026-10-03T10:05:00.000Z",
            evidence: [
              {
                kind: "trace",
                uri: "trace://verify",
                observedAt: "2026-10-03T10:05:00.000Z"
              }
            ],
            reasonCode: "verified_current_state"
          })
        },
        reconstructor: {
          reconstruct: async () => ({
            disposition: "retain",
            guidance: "A bounded claim.",
            rationale: "The cited source is unchanged."
          })
        }
      }),
    probe: async () => "reachable",
    close: async () => undefined
  };
  const savedMode = process.env.AUTODEV_MEMORY_MODE;
  clearTrustedMemoryContextsForTest();
  process.env.AUTODEV_MEMORY_MODE = "jit";
  const span = trace.getTracer("test").startSpan("autodev.router.chat");
  activeSpan = span;
  try {
    await injectOrchestratorMemory(
      {
        payload: {
          model: "autodev/orchestrator",
          instructions: "Authoritative root policy.",
          input: [{ type: "message", role: "user", content: "Do the task." }]
        },
        requestId: "request-failure",
        sessionKey: "session-failure",
        sessionScope: "identified",
        threadId: "root-thread",
        workspace: {
          key: "owner/repo",
          cwd: "/repo/autodev",
          workspace_id: "ws-1"
        }
      } satisfies OrchestratorMemoryRequest,
      host
    );
  } finally {
    activeSpan = undefined;
    span.end();
    if (savedMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = savedMode;
    clearTrustedMemoryContextsForTest();
  }

  await provider.forceFlush();
  const finished = exporter.getFinishedSpans();
  const last = finished.at(-1);
  assert.ok(last, "no span was exported; the harness is not observing");
  return last.events.map((event) => ({
    name: event.name,
    attributes: event.attributes ?? {}
  }));
}

/** The one event this file is about. */
function onlyEmissionFailure(
  events: readonly { readonly name: string; readonly attributes: Record<string, unknown> }[]
): { readonly name: string; readonly attributes: Record<string, unknown> } {
  const failures = events.filter((event) => event.name === "memory_injection_emit_failed");
  assert.equal(
    failures.length,
    1,
    `expected exactly one emission failure, saw ${JSON.stringify(events.map((e) => e.name))}`
  );
  const failure = failures[0];
  assert.ok(failure, "the emission failure disappeared between the two assertions");
  return failure;
}

test("a failed observation is recorded on the active span", async () => {
  const events = await observeFailure(
    () => new Error("the observation store is unavailable")
  );

  const failure = onlyEmissionFailure(events);
  assert.equal(failure.name, "memory_injection_emit_failed");
  // An unclassifiable error is still recorded, as "unknown" rather than dropped:
  // losing the fact that the emission failed is worse than recording it coarsely.
  assert.equal(failure.attributes["autodev.memory.error.type"], "unknown");
});

test("each memory error type gets its own bounded category", async () => {
  // The taxonomy, exhaustively. Two of these arms collapse into "unknown" if the
  // classification ever falls back to the message, and that is the failure mode
  // this table exists to catch.
  const cases: readonly (readonly [string, () => Error])[] = [
    ["conflict", () => new MemoryConflictError("duplicate")],
    ["validation", () => new MemoryValidationError("invalid")],
    ["authorization", () => new MemoryAuthorizationError("not permitted")],
    ["unknown", () => new Error("something else entirely")]
  ];

  for (const [expected, throwable] of cases) {
    const failure = onlyEmissionFailure(await observeFailure(throwable));
    assert.equal(
      failure.attributes["autodev.memory.error.type"],
      expected,
      `a ${throwable().constructor.name} was classified wrongly`
    );
  }
});

test("the emitted event carries exactly one attribute", async () => {
  // A bounded event, not an open map. Anything added here travels to whatever
  // collects the spans, so the set of keys is itself the contract.
  const failure = onlyEmissionFailure(
    await observeFailure(() => new MemoryValidationError("invalid"))
  );

  assert.deepEqual(
    Object.keys(failure.attributes),
    ["autodev.memory.error.type"],
    "the emission-failure event carried an unexpected attribute"
  );
});

test("a raw error message never reaches the emitted event", async () => {
  // The privacy boundary, asserted as an absence.
  //
  // The message used here is shaped like a real driver's: a constraint name and
  // the failing value. If the classification were ever derived from
  // `error.message`, this string would appear in every exported span.
  const secret = "duplicate key value violates unique constraint \"memory_experiences_pkey\"";
  const failure = onlyEmissionFailure(
    await observeFailure(() => new MemoryConflictError(secret))
  );

  const serialised = JSON.stringify(failure);
  assert.doesNotMatch(
    serialised,
    /duplicate key/u,
    "the driver message leaked into the telemetry event"
  );
  assert.doesNotMatch(
    serialised,
    /memory_experiences_pkey/u,
    "a table or constraint name leaked into the telemetry event"
  );
  assert.equal(
    Object.values(failure.attributes).length,
    1,
    `the message arrived as an extra attribute: ${serialised}`
  );
});

test("a failed observation does not fail the request it describes", async () => {
  // Why the emission is wrapped at all. The observation is telemetry about a
  // turn; if recording it could fail the turn, memory would be a way to take the
  // router down. Every throwable above landed here and none escaped.
  for (const throwable of [
    () => new MemoryConflictError("conflict"),
    () => new MemoryValidationError("validation"),
    () => new MemoryAuthorizationError("authorization"),
    () => new Error("plain")
  ]) {
    const failure = onlyEmissionFailure(await observeFailure(throwable));
    assert.equal(
      failure.attributes["autodev.memory.error.type"] !== undefined,
      true,
      "the emission failure was not recorded"
    );
  }
});

test("every recorded category is one of the four the taxonomy defines", async () => {
  // Closed set. A category invented here — or, more plausibly, an error's class
  // name leaking through a future `return error.constructor.name` — would
  // otherwise be a new, unbounded dimension on a metric the product groups by.
  const allowed = new Set(["conflict", "validation", "authorization", "unknown"]);

  for (const throwable of [
    () => new MemoryConflictError("c"),
    () => new MemoryValidationError("v"),
    () => new MemoryAuthorizationError("a"),
    () => new Error("plain"),
    () => new TypeError("a type error, not a memory error")
  ]) {
    const failure = onlyEmissionFailure(await observeFailure(throwable));
    const recorded = String(failure.attributes["autodev.memory.error.type"]);
    assert.equal(
      allowed.has(recorded),
      true,
      `"${recorded}" is not one of the four defined categories`
    );
  }
});