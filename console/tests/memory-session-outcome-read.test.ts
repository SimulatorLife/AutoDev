import assert from "node:assert/strict";
import test from "node:test";

import { fetchMemoryExperienceSessionOutcome } from "../src/lib/server/control-api.ts";

/**
 * The one read that decides what the session-outcome panel is allowed to say.
 *
 * `app/memory/page.ts` holds a three-way distinction that this validator is the
 * whole of: a report is shown, `autodev_memory_not_found` is drawn as "no
 * outcome exists", and everything else leaves the panel unable to say anything.
 * None of the three had a test. The read had no test *at all* — not even the
 * success case — because the only harness that reached it answered the
 * `/session-outcomes` path with the experiences *list* schema, which this
 * validator rejects on `schema`, so every page-level run exercised the
 * rejection by accident and the accepting arm never ran.
 *
 * The arm that matters most is the one the source comments on:
 *
 *   // Compared, not merely present: a response naming a different experience
 *   // is not "no outcome yet" for this one, it is the wrong answer.
 *
 * That is a real decision with an observable consequence. A report for
 * `exp-2` answered to a read of `exp-1` must land in "unable to say anything"
 * and not in "no outcome exists", because the Runtime *does* hold an outcome
 * and drawing the panel as empty asserts there is none.
 */

const CONFIG = {
  baseUrl: "http://127.0.0.1:0",
  serviceToken: "s".repeat(64)
};

const EXPERIENCE_ID = "exp-1";
const WORKSPACE = "SimulatorLife/AutoDev";

/** A response the validator accepts, with values chosen to be easy to read back. */
function projection(
  overrides: {
    readonly experienceId?: string;
    readonly schema?: string;
    readonly report?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    schema: overrides.schema ?? "autodev-memory-session-outcome-report-v1",
    experienceId: overrides.experienceId ?? EXPERIENCE_ID,
    // `in`, not `??`: a fixture that passes `report: null` is describing a
    // report that is not an object, and `??` would quietly swap in the good one
    // and make the test pass for a reason it never exercised.
    report:
      "report" in overrides
        ? overrides.report
        : {
            outcomeKind: "failure",
            reportKind: "task",
            reporterId: "operator@example",
            reportedAt: "2026-10-07T09:00:00.000Z",
            reasonCode: "reporter_supplied",
            evidence: [{ kind: "trajectory", uri: "codex://session/exp-1" }]
          }
  };
}

/**
 * Run the read against a canned response and return both the result and the
 * path it asked for. `fetchImpl` is injected rather than `globalThis.fetch`
 * reassigned, so a failure here cannot leak into another test in this file.
 */
async function read(
  body: unknown,
  options: { readonly status?: number; readonly id?: string } = {}
): Promise<{
  readonly result: Awaited<
    ReturnType<typeof fetchMemoryExperienceSessionOutcome>
  >;
  readonly path: string;
}> {
  let path = "";
  const result = await fetchMemoryExperienceSessionOutcome(
    options.id ?? EXPERIENCE_ID,
    WORKSPACE,
    CONFIG,
    {
      fetchImpl: (async (input: unknown) => {
        path = String(input).replace(/^https?:\/\/[^/]+/u, "");
        return Response.json(body as never, {
          status: options.status ?? 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    }
  );
  return { result, path };
}

test("a report for the requested session is returned, and the read asks for its task history", async () => {
  const { result, path } = await read(projection());

  assert.equal(result.kind, "ok");
  assert.equal(
    result.kind === "ok" ? result.data.report.outcomeKind : null,
    "failure"
  );
  // `includeTaskHistory` is not a formality: the Runtime gates a session
  // outcome on the caller being able to see that session's history, and the
  // Console holds no history grant of its own. Omitting it would make every
  // session outcome read a refusal.
  assert.equal(
    path,
    "/control/memory/experiences/exp-1/session-outcomes" +
      "?workspaceId=SimulatorLife%2FAutoDev&includeTaskHistory=true"
  );
});

test("a report naming a different session is refused, not shown as no outcome", async () => {
  // The decision the source comment spells out. The dangerous outcome is not
  // "the wrong report is rendered" — it is "the panel says this session has no
  // outcome", which is a claim the Runtime contradicts.
  const { result } = await read(projection({ experienceId: "exp-2" }));

  assert.equal(result.kind, "invalid-response");
  // Belt and braces on the distinction the page keys off: this must not carry
  // the code `page.ts` maps to "no outcome exists".
  assert.notEqual(
    "code" in result ? result.code : undefined,
    "autodev_memory_not_found"
  );
});

test("the Runtime's not_found reaches the Console under the code the page reads", async () => {
  // The other end of the three-way split. If this stopped matching, every
  // session without an outcome would be drawn as unreadable instead of empty,
  // and the panel would offer a form for a read it never got.
  const { result } = await read(
    { error: { code: "autodev_memory_not_found", message: "no report" } },
    { status: 404 }
  );

  assert.equal(result.kind, "http-error");
  assert.equal(
    "code" in result ? result.code : undefined,
    "autodev_memory_not_found"
  );
});

/**
 * Everything the accepting arm checks, each of which the view dereferences.
 *
 * These are not hypothetical: the panel reads all six fields and both evidence
 * keys, so an unchecked one is an `undefined` rendered into the page — the
 * failure mode the vocabulary fallbacks in `MemorySessionOutcome` already guard
 * against for the *values*, and which no guard covers for the *shape*.
 */
const REJECTIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["a body that is not an object", null],
  [
    "a different schema",
    projection({ schema: "autodev-memory-experiences-v1" })
  ],
  ["a report that is not an object", projection({ report: null as never })],
  [
    // A wrong *type*, not a missing key. Both of these fixtures would satisfy
    // a `typeof x === "string"` check and a `x in report` check alike, so a
    // missing-key fixture cannot tell the two guards apart — and the guard under
    // test is the type check, so the fixture has to violate it.
    "an outcomeKind that is not a string",
    projection({
      report: {
        outcomeKind: 42,
        reportKind: "task",
        reporterId: "operator@example",
        reportedAt: "2026-10-07T09:00:00.000Z",
        reasonCode: "reporter_supplied",
        evidence: []
      }
    })
  ],
  [
    "a non-string reportedAt",
    projection({
      report: {
        outcomeKind: "failure",
        reportKind: "task",
        reporterId: "operator@example",
        reportedAt: 1759827600000,
        reasonCode: "reporter_supplied",
        evidence: []
      }
    })
  ],
  [
    "evidence that is not an array",
    projection({
      report: {
        outcomeKind: "failure",
        reportKind: "task",
        reporterId: "operator@example",
        reportedAt: "2026-10-07T09:00:00.000Z",
        reasonCode: "reporter_supplied",
        evidence: { kind: "trajectory", uri: "codex://session/exp-1" }
      }
    })
  ],
  [
    // `null` rather than a bare string: `null` is the ordinary malformed entry
    // in a JSON array, and it is the one non-record a replacement that skipped
    // `isRecord` could not survive — it would read `.kind` off null and throw.
    "a null evidence entry",
    projection({
      report: {
        outcomeKind: "failure",
        reportKind: "task",
        reporterId: "operator@example",
        reportedAt: "2026-10-07T09:00:00.000Z",
        reasonCode: "reporter_supplied",
        evidence: [null]
      }
    })
  ],
  [
    "an evidence entry whose uri is not a string",
    projection({
      report: {
        outcomeKind: "failure",
        reportKind: "task",
        reporterId: "operator@example",
        reportedAt: "2026-10-07T09:00:00.000Z",
        reasonCode: "reporter_supplied",
        evidence: [{ kind: "trajectory", uri: 42 }]
      }
    })
  ]
];

for (const [label, body] of REJECTIONS) {
  test(`a session outcome read refuses ${label}`, async () => {
    const { result } = await read(body);

    assert.equal(
      result.kind,
      "invalid-response",
      "an unreadable shape must not reach the panel as a report"
    );
  });
}
