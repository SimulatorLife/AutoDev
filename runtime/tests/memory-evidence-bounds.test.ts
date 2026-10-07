import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The bounds on the evidence a caller attaches to a memory.
 *
 * Every value in an evidence reference is caller-controlled, and each one is
 * checked: the list's shape, the `kind` against a fixed vocabulary, a required
 * `uri`, a bounded `revision`, and an `observedAt` that must parse. These arms
 * had no test, so "evidence is bounded" was an unverified claim about the one
 * part of a durable memory that points outward at something else.
 *
 * They matter beyond tidiness. An evidence reference is what a future reader
 * follows to check a claim, so a reference that is silently accepted but unusable
 * is worse than one refused: the memory looks sourced and is not.
 *
 * Two edges are worth naming because a bound that drifts one unit in either
 * direction changes what is accepted:
 *
 * - `revision` is inclusive. 256 characters is accepted, 257 is not. A test that
 *   only tried something obviously too long would not notice a bound that had
 *   quietly become exclusive — which is the same shape as the packet's character
 *   ceiling, and the reason it is asserted from both sides here.
 *
 * - A control character in a `uri` is refused. `hasControlCharacters` exists to
 *   stop values that a terminal or a log line would render as something other
 *   than themselves, and a `\n` inside a URI is exactly that.
 *
 * An unknown key on an evidence entry used to be accepted and dropped, where the
 * same mistake elsewhere in this file is refused -- `exactKeys` guards the body,
 * the scope, and every filter object. That was left as a written-down gap on the
 * theory that tightening it would change what existing callers may send. That
 * premise has since been checked rather than assumed: the Console builds these
 * references as `{ kind, uri, revision? }` and nothing else, and no existing
 * test sends anything wider. The other two boundaries for this same type already
 * refuse it -- capture rejects an unknown field outright, and the MCP adapter
 * uses `strictObject` with the reason written down, that a misspelled or
 * smuggled field must be a hard error rather than silent data loss.
 *
 * So the asymmetry is now closed. Reversible in one line if an external caller
 * turns out to rely on the leniency.
 */

const RECORDS = "/control/memory/records";

interface AuditEntry {
  readonly action: string;
  readonly outcome: string;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>).code
    : undefined;
}

/** A store that accepts any proposal, so only validation can refuse. */
function acceptingService() {
  const proposed: Record<string, unknown>[] = [];
  const service = {
    async propose(input: Record<string, unknown>) {
      proposed.push(input);
      return { id: "mem-1" };
    }
  } as unknown as MemoryService;
  return { service, proposed };
}

async function propose(body: unknown): Promise<CallResult> {
  const { service } = acceptingService();
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  await handleMemoryControlApiRequest(
    makeRequest("POST", `${RECORDS}?workspaceId=ws-1`, body as never),
    response,
    RECORDS,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );
  return { status: response.statusCode, body: responseBody(response), audits };
}

/** A proposal with one evidence reference, the shape every case below varies. */
function withEvidence(evidence: unknown): Record<string, unknown> {
  return {
    kind: "semantic",
    scope: { kind: "workspace", workspaceId: "ws-1" },
    claim: "A bounded claim.",
    experienceIds: ["exp-1"],
    evidence
  };
}

const VALID_EVIDENCE = { kind: "trace", uri: "trace://run-1" };

test("a valid proposal with one evidence reference is stored", async () => {
  // The positive control. Without it, a validator that refused everything would
  // pass every case below.
  const { status, body } = await propose(withEvidence([VALID_EVIDENCE]));

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body?.schema, "autodev-memory-record-v1");
});

test("an unknown key on an evidence entry is refused, not dropped", async () => {
  // The entry is rebuilt field by field, so an unrecognised key used to vanish
  // without a word. A caller who misspells `revision` stored a reference that
  // silently does not carry one -- and, per the rest of this file's argument, a
  // memory that looks sourced and is not.
  //
  // `revison` is the realistic case rather than a stray `note`: the field is
  // optional, so nothing else about the payload looks wrong.
  for (const [label, entry] of [
    ["a misspelled revision", { ...VALID_EVIDENCE, revison: "abc123" }],
    ["a field from another shape", { ...VALID_EVIDENCE, note: "not part of a reference" }]
  ] as const) {
    const { status, body } = await propose(withEvidence([entry]));

    assert.equal(
      status,
      400,
      `${label} was accepted and dropped instead of refused`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_request");
  }

  // The positive control for the optional fields: both are accepted when the
  // key is spelled correctly, so the rule above is about unknown keys and not
  // about refusing the richer shape.
  const { status } = await propose(
    withEvidence([
      { ...VALID_EVIDENCE, revision: "abc123", observedAt: "2026-10-01T00:00:00.000Z" }
    ])
  );
  assert.equal(status, 200, "a fully populated reference must still be accepted");
});

test("evidence must be a non-empty array", async () => {
  for (const evidence of [
    { ...VALID_EVIDENCE },
    [],
    "trace://run-1",
    null
  ]) {
    const { status, body, audits } = await propose(withEvidence(evidence));

    assert.equal(
      status,
      400,
      `evidence ${JSON.stringify(evidence)} was accepted`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_request");
    assert.equal(audits.at(-1)?.reason, "invalid_request");
  }
});

test("an evidence kind outside the vocabulary is refused", async () => {
  // A bounded vocabulary, not a free string. The kind decides how a reader
  // follows the reference, so a typo that became a new kind would be a link
  // nobody can resolve.
  const { status, body } = await propose(
    withEvidence([{ kind: "not-a-kind", uri: "trace://run-1" }])
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("an evidence reference without a uri is refused", async () => {
  // The uri is the reference. Without it the entry names a kind and nothing
  // else, which is a claim with nothing behind it.
  const { status, body } = await propose(withEvidence([{ kind: "trace" }]));

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a revision of exactly the maximum length is accepted, one more is not", async () => {
  // The inclusive edge, asserted from both sides. `>` and not `>=`: a caller
  // naming a real 256-character revision must not be refused for it.
  const atBound = await propose(
    withEvidence([{ ...VALID_EVIDENCE, revision: "r".repeat(256) }])
  );
  assert.equal(
    atBound.status,
    200,
    `a 256-character revision was refused: ${JSON.stringify(atBound.body)}`
  );

  const overBound = await propose(
    withEvidence([{ ...VALID_EVIDENCE, revision: "r".repeat(257) }])
  );
  assert.equal(overBound.status, 400, "a 257-character revision was accepted");
  assert.equal(errorCode(overBound.body), "autodev_memory_invalid_request");
});

test("a revision that is not a string is refused", async () => {
  // The type arm beside the length arm. A number or an object is not a revision
  // that happens to be the wrong length; it is not a revision.
  for (const revision of [7, true, { sha: "abc" }, ["abc"]]) {
    const { status, body } = await propose(
      withEvidence([{ ...VALID_EVIDENCE, revision }])
    );

    assert.equal(
      status,
      400,
      `revision ${JSON.stringify(revision)} was accepted`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_request");
  }
});

test("an observedAt that does not parse as a date is refused", async () => {
  // The other optional field. A timestamp that cannot be parsed cannot be
  // ordered against anything, which is the only thing it is for.
  for (const observedAt of ["yesterday", "", "2026-13-45", "not-a-date"]) {
    const { status, body } = await propose(
      withEvidence([{ ...VALID_EVIDENCE, observedAt }])
    );

    assert.equal(
      status,
      400,
      `observedAt ${JSON.stringify(observedAt)} was accepted`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_request");
  }

  const valid = await propose(
    withEvidence([{ ...VALID_EVIDENCE, observedAt: "2026-10-03T10:00:00.000Z" }])
  );
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("a control character in an evidence uri is refused", async () => {
  // `hasControlCharacters` exists so a value cannot render as something other
  // than itself in a terminal or a log line. A newline inside a URI is the case
  // it was written for, and a caller can put one there.
  const { status, body } = await propose(
    withEvidence([{ kind: "trace", uri: "trace://run-1\nfake-line" }])
  );

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a control character in a cited experience id is refused", async () => {
  // The same rule, one level up. `experienceIds` is what the purge eligibility
  // check reads to decide whether a memory is still referenced, so a value that
  // does not survive being logged or displayed is a value that cannot be
  // compared safely downstream either.
  const { status, body } = await propose({
    ...withEvidence([VALID_EVIDENCE]),
    experienceIds: ["exp-1 fake"]
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a claim longer than the maximum is refused", async () => {
  // The largest caller-supplied string on this route. It is stored verbatim and
  // re-rendered into every packet, so the bound is what keeps a single memory
  // from crowding out the rest.
  const { status, body } = await propose({
    ...withEvidence([VALID_EVIDENCE]),
    claim: "c".repeat(4001)
  });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_request");
});

test("a refused proposal stores nothing", async () => {
  // The guarantee the audit reason implies: `invalid_request` means the store
  // was never asked, not that the store rolled something back.
  const { service, proposed } = acceptingService();
  const response: RecordedResponse = responseRecorder();
  const audits: AuditEntry[] = [];
  await handleMemoryControlApiRequest(
    makeRequest("POST", `${RECORDS}?workspaceId=ws-1`, {
      ...withEvidence([{ kind: "trace", uri: "trace://ok\nnot-ok" }])
    }),
    response,
    RECORDS,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );

  assert.equal(response.statusCode, 400);
  assert.equal(
    proposed.length,
    0,
    "a refused proposal reached the store"
  );
  assert.notEqual(audits.at(-1)?.outcome, "ok");
});

test("a malformed percent-escape in a route id is an unknown path, not a record", async () => {
  // `parseRoute` decodes the id and returns null when the escape is malformed,
  // which makes the whole request unrouted. The consequence worth pinning is
  // which of two 404s comes back.
  //
  // Both cases answer 404, so the status alone cannot tell them apart — and
  // asserting only the status is what made this test survive a mutation that
  // removed the decode entirely. The codes differ: an undecodable id is not a
  // route at all, while an id that decodes to something legal is a route whose
  // record does not exist. A caller can tell "you asked for a path that does not
  // exist" from "that path is real and holds nothing".
  const undecodable = ["%ZZ", "%E0%A4%A", "a%20b"];
  for (const id of undecodable) {
    const result = await read(`/control/memory/records/${id}`);

    assert.equal(result.status, 404, `${id}: expected 404`);
    assert.equal(
      errorCode(result.body),
      "autodev_memory_unknown_path",
      `${id}: an undecodable id was treated as a route`
    );
  }

  // `%41` is `A`, so this decodes to `aAb` — a legal id. The route runs, finds
  // no record, and says so with the not-found code rather than unknown-path.
  const decoded = await read("/control/memory/records/a%41b");
  assert.equal(decoded.status, 404);
  assert.equal(
    errorCode(decoded.body),
    "autodev_memory_not_found",
    "a decodable id did not reach the route"
  );

  // A legal id with no decode work at all behaves the same way, which is the
  // control for the case above.
  const plain = await read("/control/memory/records/ok-id");
  assert.equal(errorCode(plain.body), "autodev_memory_not_found");

  // One honest limit, established by mutating the `catch` alone and watching
  // this stay green: `%` is not in the id pattern's character class, so a
  // malformed escape is refused by the pattern whether or not the `catch`
  // catches it first. The decode is load-bearing — removing it turns `a%41b`
  // into an unknown path, which is what the assertion above catches — but the
  // catch is defence in depth whose firing nothing here can distinguish.
});

/** A read against a store that holds nothing. */
async function read(path: string): Promise<CallResult> {
  const response: RecordedResponse = responseRecorder();
  const audits: AuditEntry[] = [];
  await handleMemoryControlApiRequest(
    makeRequest("GET", `${path}?workspaceId=ws-1`),
    response,
    path,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    {
      createMemoryService: () =>
        ({
          async get() {
            return null;
          }
        }) as unknown as MemoryService
    }
  );
  return { status: response.statusCode, body: responseBody(response), audits };
}