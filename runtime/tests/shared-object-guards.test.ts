import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "../src/shared/object-guards.ts";

/**
 * The one guard that answers "is this a keyed object?".
 *
 * The Runtime reads JSON out of requests, model responses, tool calls and
 * stored records. Every one of those readers needs the same answer, and the
 * copies that answered it separately had drifted: some accepted an array and
 * some did not, so the same payload was a record in one place and a list of
 * records in another. This test holds the single owner to the contract the
 * copies agreed on.
 */
test("a keyed object is a record", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ key: "value" }), true);
  assert.equal(isRecord(Object.create(null) as object), true);
});

test("a list, a value and nothing at all are not a record", () => {
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([{ key: "value" }]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("object"), false);
  assert.equal(isRecord(0), false);
  assert.equal(isRecord(false), false);
});

test("the guard narrows the value it was given", () => {
  const value: unknown = { key: "value" };
  if (!isRecord(value)) {
    assert.fail("the value is a record");
  }
  assert.equal(value.key, "value");
});
