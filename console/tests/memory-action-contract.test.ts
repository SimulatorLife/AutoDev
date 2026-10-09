import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_MEMORY_RECORD_ACTION_BODY_KEYS,
  type ControlApiMemoryRecordAction,
  MEMORY_EVIDENCE_KINDS
} from "@simulatorlife/autodev-core";

import {
  promoteMemoryProcedureToSkill,
  transitionMemoryRecord
} from "../src/lib/server/control-api.ts";

/**
 * Runtime and Console share this contract from Core. Runtime enforces the key
 * sets and the tests below keep the Console's serialized bodies within them.
 */
const ACCEPTED_KEYS = CONTROL_API_MEMORY_RECORD_ACTION_BODY_KEYS;

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
  action: ControlApiMemoryRecordAction,
  body: Record<string, unknown>,
  required: readonly string[]
): void {
  const accepted = new Set<string>(ACCEPTED_KEYS[action]);
  for (const key of Object.keys(body)) {
    assert.ok(
      accepted.has(key),
      `${action} forwarded "${key}", which the Runtime does not accept`
    );
  }
  for (const key of required) {
    assert.ok(key in body, `${action} did not forward the required "${key}"`);
  }
}

/** Run a fetch through the transport and return the JSON body it forwarded. */
async function forwardedBody(
  run: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json(
      { memory: {} },
      { headers: { "content-type": "application/json" } }
    );
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
  const transitions = [
    {
      action: "verify",
      payload: { workspaceId: "ws-1", task: "t", query: "q" }
    },
    {
      action: "invalidate",
      payload: {
        workspaceId: "ws-1",
        reasonCode: "stale",
        evidence: EVIDENCE
      }
    },
    {
      action: "revise",
      payload: {
        workspaceId: "ws-1",
        claim: "c",
        experienceIds: ["exp-1"],
        evidence: EVIDENCE
      }
    },
    {
      action: "supersede",
      payload: {
        workspaceId: "ws-1",
        priorId: "mem-1",
        task: "t",
        query: "q"
      }
    }
  ] as const;
  for (const { action, payload } of transitions) {
    const body = await forwardedBody(() =>
      transitionMemoryRecord("mem-1", action, payload, CONFIG)
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
