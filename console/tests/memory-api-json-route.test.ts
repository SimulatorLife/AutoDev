import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as memoryRoute from "../app/api/memory/route.ts";

/**
 * `/api/memory` has two callers and only one of them was exercised. Every
 * existing route test submits a form, which is what an operator's browser does,
 * and that left the whole JSON body path uncovered — plus two actions the form
 * path never reached either: `invalidate` and `promote-skill`. Their refusals
 * are operator-facing text, and `promote-skill` is the only place the Console
 * derives a skill name rather than taking one.
 *
 * The two shapes also answer differently on purpose: a form submission is a
 * browser navigation, so a refusal redirects back into the Console carrying the
 * cause; a programmatic caller gets a status and a body. Both are pinned here,
 * because the difference is the difference between an operator who is told what
 * went wrong and one handed a JSON object outside the Console shell.
 */

const EVIDENCE = [{ kind: "file", uri: "config/runtime.json" }];

function formRequest(fields: Record<string, string>): NextRequest {
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

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://console.test/api/memory", {
    method: "POST",
    headers: {
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

interface Outcome {
  readonly sent: string[];
  readonly status: number;
  readonly body: unknown;
  readonly location: string;
}

async function submit(
  make: () => NextRequest,
  respond: () => Response = () =>
    Response.json({ schema: "autodev-memory-records-v1" }, { status: 200 }),
  options: { readonly configure?: boolean } = {}
): Promise<Outcome> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBase = process.env.AUTODEV_CONTROL_API_BASE_URL;
  if (options.configure === false) {
    delete process.env.AUTODEV_CONTROL_API_TOKEN;
    delete process.env.AUTODEV_CONTROL_API_BASE_URL;
  } else {
    process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
    process.env.AUTODEV_CONTROL_API_BASE_URL = "http://control.test";
  }
  const sent: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    sent.push(String(init?.body ?? ""));
    return respond();
  }) as typeof fetch;
  try {
    const response = await memoryRoute.POST(make());
    return {
      sent,
      status: response.status,
      body: await response.json().catch(() => null),
      location: response.headers.get("location") ?? ""
    };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [
      ["AUTODEV_CONTROL_API_TOKEN", previousToken],
      ["AUTODEV_CONTROL_API_BASE_URL", previousBase]
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a JSON submission is answered with a status, not a redirect", async () => {
  // The whole non-form path: parse, dispatch, and answer the caller directly.
  // Before this, `parsePayload`'s JSON branch and `respond`'s JSON arm were
  // never executed by any test.
  const outcome = await submit(() =>
    jsonRequest({
      action: "invalidate",
      recordId: "mem-1",
      workspaceId: "ws-1",
      reason: "contradicted",
      evidence: EVIDENCE
    })
  );

  assert.equal(outcome.status, 200);
  assert.equal(outcome.location, "", "a JSON caller is not navigated away");
  assert.deepEqual(outcome.body, {
    success: true,
    action: "invalidate",
    id: "mem-1"
  });
});

test("the JSON body is read with the same rules a form body is", async () => {
  // Evidence is rebuilt from `kind`/`uri` pairs, ids are trimmed, and blanks are
  // dropped — a form does that through the field names, so a JSON caller that
  // sent a looser shape would otherwise reach the Runtime differently.
  const outcome = await submit(() =>
    jsonRequest({
      action: "invalidate",
      recordId: "  mem-1  ",
      reason: "contradicted",
      evidence: [
        { kind: " file ", uri: " config/runtime.json " },
        { kind: "", uri: "dropped.json" },
        "not an object",
        { kind: "file", uri: "second.json" }
      ]
    })
  );

  assert.equal(outcome.status, 200);
  const forwarded = JSON.parse(outcome.sent[0] ?? "{}") as {
    evidence?: unknown;
  };
  assert.deepEqual(forwarded.evidence, [
    { kind: "file", uri: "config/runtime.json" },
    { kind: "file", uri: "second.json" }
  ]);
});

test("invalidation names the field that is missing rather than a generic refusal", async () => {
  // Permanent, so the Runtime wants a bounded reason code and evidence of what
  // contradicted the record. Both refusals are checked here so the operator is
  // told which field is absent instead of receiving the Runtime's 400.
  const noEvidence = await submit(() =>
    formRequest({
      action: "invalidate",
      recordId: "mem-1",
      reason: "contradicted"
    })
  );
  assert.match(noEvidence.location, /evidence_required/u);

  const badReason = await submit(() =>
    formRequest({
      action: "invalidate",
      recordId: "mem-1",
      reason: "it seemed wrong",
      evidenceKind: "file",
      evidenceUri: "config/runtime.json"
    })
  );
  assert.match(badReason.location, /reason_not_accepted/u);
});

test("a valid invalidation forwards a reason code and evidence, not free text", async () => {
  const outcome = await submit(() =>
    formRequest({
      action: "invalidate",
      recordId: "mem-1",
      workspaceId: "ws-1",
      reason: "contradicted",
      evidenceKind: "file",
      evidenceUri: "config/runtime.json"
    })
  );

  // A form submission answers 303 whether it succeeded or was refused -- the
  // refusal is carried in the redirect, not the status -- so the discriminator
  // is the absence of a refusal reason, not the code.
  assert.equal(outcome.status, 303);
  assert.doesNotMatch(
    outcome.location,
    /evidence_required|reason_not_accepted/u,
    "a complete invalidation is not answered with a refusal reason"
  );
  const forwarded = JSON.parse(outcome.sent[0] ?? "{}") as Record<
    string,
    unknown
  >;
  assert.equal(forwarded.reasonCode, "contradicted");
  assert.equal(forwarded.reason, undefined, "free text is not forwarded");
  assert.deepEqual(forwarded.evidence, EVIDENCE);
});

test("skill promotion derives a name when the operator supplies none", async () => {
  // The only place the Console invents anything: a name derived from the record
  // id, so a promotion with no explicit name is still sendable rather than
  // refused for a field the form never showed.
  const outcome = await submit(() =>
    jsonRequest({
      action: "promote-skill",
      recordId: "mem-abcdef1234567890",
      workspaceId: "ws-1",
      reason: "Two runs passed",
      promotedContent: "Re-check evidence and run focused tests."
    })
  );

  assert.equal(outcome.status, 200);
  const forwarded = JSON.parse(outcome.sent[0] ?? "{}") as Record<
    string,
    unknown
  >;
  assert.equal(forwarded.skillName, "memory-proc-mem-abcd");
  assert.equal(
    forwarded.description,
    "Promoted from durable procedure memory mem-abcdef1234567890"
  );
  assert.equal(forwarded.content, "Re-check evidence and run focused tests.");
  assert.equal(
    forwarded.memoryId,
    undefined,
    "the identifier lives in the path, not in a body the Runtime would reject"
  );
});

test("skill promotion names its own missing fields", async () => {
  // A revision says "reason not accepted" for an absent body because the reason
  // was filled in fine; the same discipline applies here.
  const noReason = await submit(() =>
    formRequest({
      action: "promote-skill",
      recordId: "mem-1",
      promotedContent: "content"
    })
  );
  assert.match(noReason.location, /reason_required/u);

  const noContent = await submit(() =>
    formRequest({
      action: "promote-skill",
      recordId: "mem-1",
      reason: "Two runs passed"
    })
  );
  assert.match(noContent.location, /content_required/u);
});

test("an action this route does not implement is a 400 with no cause", async () => {
  const outcome = await submit(() =>
    jsonRequest({ action: "not-an-action", recordId: "mem-1" })
  );

  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.body, {
    error: "Invalid request payload or unsupported action"
  });
  assert.equal(
    outcome.sent.length,
    0,
    "an unroutable action is never forwarded"
  );
});

test("a missing identifier is refused before anything is forwarded", async () => {
  // Promotion, deliberately: it has no precondition of its own to refuse on, so
  // with the identifier gate gone it would go on to derive a name from an empty
  // record id and send the request. Asserting this against `invalidate` would
  // pass either way — that action refuses for want of evidence first, which says
  // nothing about the identifier.
  const outcome = await submit(() =>
    jsonRequest({
      action: "promote-skill",
      reason: "Two runs passed",
      promotedContent: "content"
    })
  );

  assert.equal(outcome.status, 400);
  assert.equal(outcome.sent.length, 0);

  // The same action with an identifier is refused for a different reason, so the
  // two are distinguishable and the 400 above is about the identifier.
  const complete = await submit(() =>
    jsonRequest({
      action: "promote-skill",
      recordId: "mem-1",
      reason: "Two runs passed",
      promotedContent: "content"
    })
  );
  assert.equal(complete.status, 200);
});
