import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryReadContext,
  MemoryRecordUseReportInput
} from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The assessment and cohort routes carry `actor.role === "operator" &&
 * context.canReadTaskHistory` in five places. Falsifying this block found ten of
 * thirteen guards deletable, but the deletions are not uniform, and three of
 * them turned out to be unreachable rather than unenforced.
 *
 * The route-level gates are *second* copies of a check that already happened:
 * with the gate removed from the use-assessment read, the request is still
 * refused 403 with reason `scope_filter_forbidden`, thrown before the route
 * function is entered. That is `readContext`'s own grant check — the one this
 * suite already pins — so those four copies can never be the thing that
 * refuses. They are defence in depth, not enforcement, and the tests below say
 * so rather than pretending each route answers for itself. Collapsing them onto
 * the single check is a reasonable follow-up; it is not done here because it is
 * a behaviour-preserving refactor of working code, not a coverage fix.
 *
 * What the block *was* missing: an experience the caller cannot see has to be a
 * 404 rather than a write against nothing, and the reported use kind and the
 * memory id list have to be validated at the boundary. Those three now fail
 * when their guards are removed.
 */

const EXPERIENCE: ExperienceEnvelope = {
  id: "exp-1",
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  scope: {
    kind: "task",
    workspaceId: "ws-1",
    taskId: "task-1",
    runId: "run-1"
  },
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  startedAt: "2026-09-01T10:00:00.000Z",
  completedAt: "2026-09-01T10:05:00.000Z",
  outcome: "success",
  memoryMode: "jit",
  trajectory: {
    recordCount: 1,
    format: "text",
    uri: "codex://captured/exp-1"
  },
  evidence: []
};

const USE_BODY = {
  injectionEventId: "event-1",
  useKind: "used",
  usedMemoryIds: ["mem-1"],
  evidence: [{ kind: "trajectory", uri: EXPERIENCE.trajectory.uri }]
} as const;

interface Recorded {
  readonly input: MemoryRecordUseReportInput;
  readonly actor: { readonly id: string };
  readonly context: MemoryReadContext;
}

interface Result {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: Array<Record<string, unknown>>;
  readonly recorded: Recorded[];
}

function service(recorded: Recorded[], experience: ExperienceEnvelope | null) {
  return {
    getExperience: async () => experience,
    recordInjectionUseReport: async (input: MemoryRecordUseReportInput) => {
      recorded.push({
        input,
        actor: input.actor,
        context: input.context
      });
      return { appended: true, id: "report-1" };
    },
    listInjectionUseJoins: async () => ({
      items: [],
      total: 0,
      limit: 25,
      offset: 0
    }),
    aggregateInjectionUseCohorts: async () => ({ items: [], total: 0 })
  } as unknown as MemoryService;
}

async function call(
  pathname: string,
  query: Record<string, string>,
  options: {
    readonly method?: string;
    readonly body?: Record<string, unknown>;
    readonly actorRole?: "viewer" | "operator";
    readonly grant?: boolean;
    readonly experience?: ExperienceEnvelope | null;
  } = {}
): Promise<Result> {
  const search = new URLSearchParams(query).toString();
  const request = makeRequest(
    options.method ?? "GET",
    search ? `${pathname}?${search}` : pathname,
    options.body
  );
  const response = responseRecorder();
  const audits: Array<Record<string, unknown>> = [];
  const recorded: Recorded[] = [];
  const previous = process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  if (options.grant === false) {
    delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
  } else {
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = "1";
  }
  try {
    await handleMemoryControlApiRequest(
      request,
      response,
      pathname,
      { actor: "test-operator", role: options.actorRole ?? "operator" },
      (event) => audits.push(event),
      {
        createMemoryService: () =>
          service(
            recorded,
            options.experience === undefined ? EXPERIENCE : options.experience
          )
      }
    );
  } finally {
    if (previous === undefined)
      delete process.env.AUTODEV_MEMORY_READ_TASK_HISTORY;
    else process.env.AUTODEV_MEMORY_READ_TASK_HISTORY = previous;
  }
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits,
    recorded
  };
}

function code(body: Record<string, unknown> | null): unknown {
  const envelope = body?.error as { code?: unknown } | undefined;
  return envelope?.code;
}

const SCOPE = { workspaceId: "ws-1", repositoryId: "repo-1" } as const;
const USE_PATH = "/control/memory/experiences/exp-1/use-assessments";
const ASSESSMENT_READ = USE_PATH;
const USE_COHORTS = "/control/memory/use-cohorts";

test("reporting an injection use requires the task-history grant, not just the operator role", async () => {
  const withoutGrant = await call(
    USE_PATH,
    { ...SCOPE, includeTaskHistory: "true" },
    { method: "POST", body: { ...USE_BODY }, grant: false }
  );
  assert.equal(withoutGrant.status, 403);
  assert.equal(withoutGrant.recorded.length, 0, "no use report was written");

  // The grant is the environment flag, not the query parameter.
  const granted = await call(
    USE_PATH,
    { ...SCOPE, includeTaskHistory: "true" },
    { method: "POST", body: { ...USE_BODY } }
  );
  assert.equal(granted.status, 200);
  assert.equal(granted.recorded.length, 1, "the grant admits the same request");

  // And the report binds to the host's own context, never to the body's.
  assert.equal(granted.recorded.at(-1)?.context.workspaceId, "ws-1");
  assert.equal(granted.recorded.at(-1)?.actor.id, "test-operator");
});

test("reading injection-use assessments requires the task-history grant", async () => {
  const withoutGrant = await call(
    ASSESSMENT_READ,
    { ...SCOPE, includeTaskHistory: "true" },
    { grant: false }
  );
  assert.equal(withoutGrant.status, 403);
  assert.equal(code(withoutGrant.body), "autodev_memory_scope_forbidden");

  assert.equal(
    (await call(ASSESSMENT_READ, { ...SCOPE, includeTaskHistory: "true" }))
      .status,
    200
  );
});

test("reading injection-use cohorts requires the task-history grant", async () => {
  // `occurredFrom`/`occurredUntil` are required on this route; they are supplied
  // here so the only thing that can refuse the first case is the grant.
  const window = {
    ...SCOPE,
    includeTaskHistory: "true",
    occurredFrom: "2026-09-01T00:00:00.000Z",
    occurredUntil: "2026-09-02T00:00:00.000Z"
  };
  const withoutGrant = await call(USE_COHORTS, window, { grant: false });
  assert.equal(withoutGrant.status, 403);
  assert.equal(code(withoutGrant.body), "autodev_memory_scope_forbidden");

  assert.equal((await call(USE_COHORTS, window)).status, 200);
});

test("a viewer is refused the task-history reads, whoever wrote the query", async () => {
  for (const pathname of [ASSESSMENT_READ, USE_COHORTS]) {
    const { status, body } = await call(
      pathname,
      { ...SCOPE, includeTaskHistory: "true" },
      { actorRole: "viewer" }
    );
    assert.equal(status, 403, `${pathname} refuses a viewer`);
    assert.equal(code(body), "autodev_memory_scope_forbidden");
  }
});

test("an experience the caller cannot see is a 404, not a write", async () => {
  const missing = await call(
    USE_PATH,
    { ...SCOPE, includeTaskHistory: "true" },
    { method: "POST", body: { ...USE_BODY }, experience: null }
  );
  assert.equal(missing.status, 404);
  assert.equal(code(missing.body), "autodev_memory_not_found");
  assert.equal(
    missing.recorded.length,
    0,
    "nothing was written for an invisible experience"
  );
});

test("a use report body is bounded: kind, id length, and the memory id list", async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["an unknown use kind", { ...USE_BODY, useKind: "sort_of_used" }],
    [
      "a missing use kind",
      { injectionEventId: "event-1", usedMemoryIds: [], evidence: [] }
    ],
    [
      "an oversized injection event id",
      { ...USE_BODY, injectionEventId: "e".repeat(257) }
    ],
    [
      "a memory id list that is not an array",
      { ...USE_BODY, usedMemoryIds: "mem-1" }
    ],
    [
      "a memory id list past its count",
      {
        ...USE_BODY,
        usedMemoryIds: Array.from({ length: 65 }, (_, index) => `mem-${index}`)
      }
    ],
    ["a blank memory id", { ...USE_BODY, usedMemoryIds: ["  "] }],
    [
      "an oversized memory id",
      { ...USE_BODY, usedMemoryIds: ["m".repeat(257)] }
    ]
  ];

  for (const [label, body] of cases) {
    const { status, recorded } = await call(
      USE_PATH,
      { ...SCOPE, includeTaskHistory: "true" },
      { method: "POST", body }
    );
    assert.equal(status, 400, `${label} is refused`);
    assert.equal(recorded.length, 0, `${label} wrote nothing`);
  }
});

test("every refused use report is audited as a refusal, never as a success", async () => {
  const results = [
    await call(
      USE_PATH,
      { ...SCOPE, includeTaskHistory: "true" },
      { method: "POST", body: { ...USE_BODY }, grant: false }
    ),
    await call(
      USE_PATH,
      { ...SCOPE, includeTaskHistory: "true" },
      { method: "POST", body: { ...USE_BODY, useKind: "nope" } }
    ),
    await call(
      USE_PATH,
      { ...SCOPE, includeTaskHistory: "true" },
      { method: "POST", body: { ...USE_BODY }, experience: null }
    )
  ];

  for (const result of results) {
    assert.ok(result.audits.length > 0, "a refusal must be audited");
    assert.notEqual(result.audits.at(-1)?.outcome, "ok");
  }
});
