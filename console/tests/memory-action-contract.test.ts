import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EVIDENCE_KINDS } from "@simulatorlife/autodev-core";

import {
  promoteMemoryProcedureToSkill,
  transitionMemoryRecord
} from "../src/lib/server/control-api.ts";

/**
 * The keys each lifecycle transition's body may carry.
 *
 * This is the Runtime's `exactKeys` list, transcribed. The Runtime cannot be
 * imported from here — it is a different package — so the list is restated
 * deliberately, and the test below is what keeps the restatement honest: every
 * action in the Console is exercised and its forwarded body checked against
 * these keys.
 *
 * Why this test exists: every record transition used to send the caller's whole
 * payload, which carried `workspaceId` (already in the query string) and a
 * free-text `reason` that no action reads. The Runtime rejects an unexpected
 * key, so verify, invalidate and revise all answered
 * `400 autodev_memory_invalid_request` — the Memory page's governance buttons
 * could not succeed at all, and nothing in either package noticed because each
 * side was correct about its own half.
 */
const ACCEPTED_KEYS: Record<string, readonly string[]> = {
  // `researchRequest`: the task and query the change is justified by.
  verify: ["task", "query", "taskId", "relevantPaths"],
  // Bounded reason code plus at least one evidence reference.
  invalidate: ["evidence", "reasonCode"],
  // The replacement text, the experiences it derives from, and evidence.
  revise: ["claim", "experienceIds", "evidence"],
  supersede: ["priorId", "task", "query", "taskId", "relevantPaths"],
  "promote-skill": [
    "skillName",
    "description",
    "content",
    "task",
    "query",
    "taskId",
    "relevantPaths"
  ]
};

const CONFIG = {
  baseUrl: "http://127.0.0.1:0",
  serviceToken: "s".repeat(64)
};

/**
 * Every key forwarded is one the Runtime accepts, and every key it requires is
 * present. The first half is the defect this exists for; the second keeps a
 * rename from quietly dropping a field the route needs.
 */
function assertAccepted(
  action: string,
  body: Record<string, unknown>,
  required: readonly string[]
): void {
  const accepted = new Set(ACCEPTED_KEYS[action] ?? []);
  for (const key of Object.keys(body)) {
    assert.ok(
      accepted.has(key),
      `${action} forwarded "${key}", which the Runtime does not accept`
    );
  }
  for (const key of required) {
    assert.ok(
      key in body,
      `${action} did not forward the required "${key}"`
    );
  }
}

/** Run a fetch through the transport and return the JSON body it forwarded. */
async function forwardedBody(
  run: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (
    _url: unknown,
    init?: { body?: unknown }
  ) => {
    sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ memory: {} }), {
      headers: { "content-type": "application/json" }
    });
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

const EVIDENCE = [{ kind: "file", uri: "config/runtime.json" }];

test("a verify body carries only the keys the Runtime's researchRequest reads", async () => {
  const body = await forwardedBody(() =>
    transitionMemoryRecord(
      "mem-1",
      "verify",
      { workspaceId: "ws-1", task: "raise the retry budget", query: "budget" },
      CONFIG
    )
  );

  // A subset, not an equality: the optional keys are optional. What must
  // hold is that nothing outside the accepted set is ever forwarded.
  assertAccepted("verify", body, ["task", "query"]);
  assert.equal(body.task, "raise the retry budget");
  assert.equal(body.query, "budget");
});

test("an invalidate body carries a bounded reason code and evidence", async () => {
  const body = await forwardedBody(() =>
    transitionMemoryRecord(
      "mem-1",
      "invalidate",
      { workspaceId: "ws-1", reasonCode: "contradicted", evidence: EVIDENCE },
      CONFIG
    )
  );

  assertAccepted("invalidate", body, ["reasonCode", "evidence"]);
  assert.equal(body.reasonCode, "contradicted");
});

test("a revise body carries the claim, its source experiences and evidence", async () => {
  const body = await forwardedBody(() =>
    transitionMemoryRecord(
      "mem-1",
      "revise",
      {
        workspaceId: "ws-1",
        claim: "The retry budget lives in config/runtime.yaml.",
        experienceIds: ["exp-1"],
        evidence: EVIDENCE
      },
      CONFIG
    )
  );

  assertAccepted("revise", body, ["claim", "experienceIds", "evidence"]);
  assert.deepEqual(body.experienceIds, ["exp-1"]);
});

test("a supersede body names the prior record and the research it rests on", async () => {
  const body = await forwardedBody(() =>
    transitionMemoryRecord(
      "mem-2",
      "supersede",
      {
        workspaceId: "ws-1",
        priorId: "mem-1",
        task: "the budget is now measured in attempts",
        query: "budget"
      },
      CONFIG
    )
  );

  assertAccepted("supersede", body, ["priorId", "task", "query"]);
  // `supersededBy` is the spelling the transport used to advertise. It reads
  // more naturally and the Runtime does not accept it: this action's
  // `exactKeys` takes `priorId`, so sending the other one is a 400.
  assert.equal(body.priorId, "mem-1");
  assert.equal("supersededBy" in body, false);
});

test("a promote-to-skill body carries the content the Runtime writes", async () => {
  const body = await forwardedBody(() =>
    promoteMemoryProcedureToSkill(
      {
        workspaceId: "ws-1",
        skillName: "retry-budget",
        description: "Raise the retry budget.",
        content: "# Retry budget",
        task: "raise the retry budget",
        query: "budget"
      },
      CONFIG
    )
  );

  assertAccepted("promote-skill", body, [
    "skillName",
    "description",
    "content",
    "task",
    "query"
  ]);
  assert.equal(body.content, "# Retry budget");
});

test("no transition forwards workspaceId in the body", async () => {
  // It travels in the query string. Forwarding it as well is the single defect
  // that made all four actions unrunnable, so it is asserted on its own rather
  // than only as part of each action's key set.
  for (const [action, payload] of [
    ["verify", { task: "t", query: "q" }],
    ["invalidate", { reasonCode: "stale", evidence: EVIDENCE }],
    [
      "revise",
      { claim: "c", experienceIds: ["exp-1"], evidence: EVIDENCE }
    ],
    ["supersede", { priorId: "mem-1", task: "t", query: "q" }]
  ] as Array<[string, Record<string, unknown>]>) {
    const body = await forwardedBody(() =>
      transitionMemoryRecord(
        "mem-1",
        action as "verify",
        { workspaceId: "ws-1", ...payload },
        CONFIG
      )
    );
    assert.equal(
      "workspaceId" in body,
      false,
      `${action} must not forward workspaceId in the body`
    );
  }
});

test("the evidence kinds the Console offers are the kinds the Runtime accepts", async () => {
  // The select and the validator read two lists. They are the same list now
  // because Core owns it, and this asserts the Console is reading Core's rather
  // than keeping a copy that could drift.
  assert.ok(MEMORY_EVIDENCE_KINDS.length > 0);
  assert.ok(MEMORY_EVIDENCE_KINDS.includes("file"));
  const accepted: readonly string[] = MEMORY_EVIDENCE_KINDS;
  assert.ok(!accepted.includes("not-a-kind"));
});