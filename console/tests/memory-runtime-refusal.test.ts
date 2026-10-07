import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import * as memoryRoute from "../app/api/memory/route.ts";
import {
  CONTROL_REFUSAL_REASONS,
  type ControlRefusalReason,
  readControlRefusal
} from "../src/lib/control-failure.ts";
import { ControlFailureNotice } from "../src/components/status/ControlFailureNotice.ts";

/**
 * Every code the memory Control API can answer a mutation with, and the refusal
 * the operator is shown for it.
 *
 * The Runtime states its reasons with machine-readable codes, and each asks for a
 * different next move. This table is the seam where that becomes a sentence: a
 * code the route does not recognise falls through to `runtime_refused`, whose
 * sentence deliberately says only that the change did not happen and does not
 * guess why. That is the correct behaviour for an unknown code, which is exactly
 * what makes an accidental fall-through invisible — the operator is told a true
 * but useless thing and has no way to tell it from a deliberate answer.
 *
 * So the table is pinned in both directions: each code maps to the reason that
 * describes it, and each reason is reachable from some code. A reason nothing
 * produces is a sentence no operator will ever read, described as though it
 * mattered.
 */

function mutation(fields: Record<string, string>): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

const SUPERSEDE = {
  action: "supersede",
  recordId: "mem-1",
  priorId: "mem-0",
  workspaceId: "SimulatorLife/AutoDev",
  reason: "A research task justifying the supersession."
} as const;

async function refusalForCode(
  status: number,
  code: string
): Promise<string | undefined> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  globalThis.fetch = (async () =>
    Response.json(
      { error: { message: "Runtime said so.", code, type: "t" } },
      { status }
    )) as typeof fetch;
  try {
    const response = await memoryRoute.POST(mutation({ ...SUPERSEDE }));
    const location = response.headers.get("location") ?? "";
    return readControlRefusal(
      new URL(location, "http://console.test").searchParams.get("refusal") ?? undefined
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
}

/**
 * Every `autodev_memory_*` code the Runtime answers a memory mutation with, as
 * of `runtime/src/control-api/memory.ts`. Listed here rather than derived, so
 * that a code the Runtime adds shows up as a case this table does not cover.
 */
const RUNTIME_CODES: readonly [number, string, ControlRefusalReason][] = [
  [409, "autodev_memory_experience_referenced", "still_cited"],
  [409, "autodev_memory_conflict", "conflicted"],
  [404, "autodev_memory_not_found", "not_found"],
  [403, "autodev_memory_scope_forbidden", "forbidden"],
  [403, "autodev_memory_viewer_forbidden", "forbidden"],
  [403, "autodev_memory_task_history_forbidden", "forbidden"],
  [403, "autodev_memory_forbidden", "forbidden"],
  [503, "autodev_memory_unavailable", "unavailable"],
  [503, "autodev_memory_operation_failed", "operation_failed"],
  // Both invalid-request codes name their cause — "Memory request failed
  // validation." and "Native trajectory capture input is invalid." — so they
  // are not the fallback. This table listed `invalid_request` as falling
  // through on purpose, on the reasoning that the Runtime "said only that the
  // request was invalid". That is a 400 with a stated cause, and routing it to
  // the fallback told the operator the Runtime had not said why.
  [400, "autodev_memory_invalid_request", "request_invalid"],
  [400, "autodev_memory_capture_invalid", "request_invalid"]
];

test("each Runtime code reaches the refusal that describes it", async () => {
  for (const [status, code, expected] of RUNTIME_CODES) {
    assert.equal(
      await refusalForCode(status, code),
      expected,
      `${code} (${status}) was reported as the wrong reason`
    );
  }
});

test("a failed operation is not reported as a refusal with no reason", async () => {
  // The specific false cause this mapping exists to prevent. The Runtime said
  // why — the operation failed — and the fallback's sentence denies that it
  // said anything, which sends the operator to re-examine a form that was
  // correct.
  const refusal = await refusalForCode(
    503,
    "autodev_memory_operation_failed"
  );

  assert.equal(refusal, "operation_failed");
  assert.notEqual(refusal, "runtime_refused");

  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, {
      refusal: refusal ?? undefined
    })
  );
  assert.doesNotMatch(
    markup,
    /did not say why/u,
    "the fallback's sentence must not be shown for a reason the Runtime gave"
  );
});

test("an unreachable Runtime is not confused with a failed operation", async () => {
  // Both arrive as a 5xx and both mean nothing changed, but they ask opposite
  // questions: one is about this machine's network, the other about work that
  // started and failed. Only the second is worth retrying immediately.
  assert.equal(await refusalForCode(503, "autodev_memory_unavailable"), "unavailable");
  assert.equal(
    await refusalForCode(503, "autodev_memory_operation_failed"),
    "operation_failed"
  );
});

test("an invalid request is not reported as a refusal with no reason", async () => {
  // The other false cause this table used to produce, and the same shape as the
  // failed-operation case below. The Runtime named a cause — validation failed
  // — and the fallback's sentence denies that it named anything, which sends an
  // operator to re-read a form whose contents were never the problem: the route
  // assembles these bodies, so the thing to report is the Console, not them.
  for (const code of [
    "autodev_memory_invalid_request",
    "autodev_memory_capture_invalid"
  ]) {
    const refusal = await refusalForCode(400, code);

    assert.equal(refusal, "request_invalid", `${code} was reported wrongly`);
    assert.notEqual(refusal, "runtime_refused");

    const markup = renderToStaticMarkup(
      React.createElement(ControlFailureNotice, {
        refusal: refusal ?? undefined
      })
    );
    assert.doesNotMatch(
      markup,
      /did not say why/u,
      `${code} states a cause, so the notice must not claim none was given`
    );
    assert.match(
      markup,
      /rejected this request as invalid/u,
      `${code} must be shown as the stated cause it is`
    );
  }
});

test("an unrecognised code still falls through rather than guessing", async () => {
  // The fallback has to stay neutral. A code this build has never seen may name
  // a cause the Console would otherwise invent, and `readControlRefusal` also
  // drops values it does not know, so the notice renders without a detail line
  // rather than with a wrong one.
  const refusal = await refusalForCode(400, "autodev_memory_some_future_thing");

  assert.equal(refusal, "runtime_refused");

  // Pinning the *reason* is not enough. Every other sentence in this table is
  // allowed to name a cause because the code named it; the fallback's whole
  // value is that it does not. It used to blame a citation conflict for every
  // failure, which sent an operator whose supersession was rejected for an
  // unrelated reason looking for citations that were never involved — so the
  // sentence itself has to be guarded, not just the mapping that reaches it.
  const markup = renderToStaticMarkup(
    React.createElement(ControlFailureNotice, { refusal: "runtime_refused" })
  );
  const detail = /<span class="[^"]*">([^<]+)</u.exec(markup)?.[1] ?? "";
  assert.doesNotMatch(
    detail,
    /citing|citation|scope|conflict|stale|not permitted|unreachable/u,
    "the neutral fallback must not name a cause the Runtime never stated"
  );
  assert.match(
    detail,
    /did not say why/u,
    "the fallback should say that no reason was given, which is what it knows"
  );
});

test("every refusal the route can emit has a sentence of its own", async () => {
  // Unreachable reasons are the other half of the same problem: a sentence no
  // code produces reads as coverage and is not. Only the refusals the route
  // raises on its own may be unreachable from a Runtime code, so anything else
  // unreachable is a sentence nobody will ever read.
  const ROUTE_EMITTED: readonly ControlRefusalReason[] = [
    "confirmation_missing",
    "reason_not_accepted",
    "reason_required",
    "claim_required",
    "content_required",
    "prior_required",
    "evidence_required",
    "provenance_required"
  ];
  const reachable = new Set(RUNTIME_CODES.map(([, , reason]) => reason));
  // The fallback is reachable, but not through a listed code — through the
  // `default:` branch, for every code this build does not recognise. It was
  // reachable through a listed code only while `invalid_request` fell through,
  // which is why it needs naming here rather than a row in the table: leaving
  // it out of both would have quietly made the guard pass by deletion.
  // `an unrecognised code still falls through rather than guessing` covers that
  // branch directly.
  reachable.add("runtime_refused");
  const unreachable = CONTROL_REFUSAL_REASONS.filter(
    (reason) => !reachable.has(reason)
  );

  assert.deepEqual(
    unreachable.filter((reason) => !ROUTE_EMITTED.includes(reason)),
    [],
    "every Runtime-derived refusal must be reachable from some Runtime code"
  );
  assert.ok(
    reachable.has("operation_failed"),
    "a failed operation must be distinguishable from the neutral fallback"
  );

  for (const [, , reason] of RUNTIME_CODES) {
    const markup = renderToStaticMarkup(
      React.createElement(ControlFailureNotice, { refusal: reason })
    );
    const detail = /<span class="[^"]*">([^<]+)</u.exec(markup)?.[1] ?? "";
    assert.ok(
      detail.length > 30,
      `${reason} must render a real explanation, got: ${JSON.stringify(detail)}`
    );
  }
});