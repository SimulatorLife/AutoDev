import assert from "node:assert/strict";
import test from "node:test";

import { isCount, isRecord } from "../src/shared/object-guards.ts";

/**
 * The one owner of "this value is a keyed object" and "this value is a count".
 *
 * The Runtime, the Data layer and the Console all read JSON out of requests,
 * model responses, tool calls and stored records. Every one of those readers
 * needs the same answer, and these tests hold the single owner to its
 * structural and numeric contract.
 */
test("isRecord accepts non-null, non-array objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ key: "value" }), true);
  assert.equal(isRecord(Object.create(null) as object), true);
  assert.equal(isRecord(new Date()), true);
  assert.equal(isRecord(Object.create({ inherited: true }) as object), true);
  assert.equal(isRecord(new (class Fixture {})()), true);
});

test("isRecord rejects null, arrays, and primitives", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([{ key: "value" }]), false);
  assert.equal(isRecord("object"), false);
  assert.equal(isRecord(""), false);
  assert.equal(isRecord(0), false);
  assert.equal(isRecord(1), false);
  assert.equal(isRecord(false), false);
  assert.equal(isRecord(true), false);
  assert.equal(isRecord(1n), false);
});

test("isRecord narrows the value it was given", () => {
  const value: unknown = { key: "value" };
  if (!isRecord(value)) {
    assert.fail("the value is a record");
  }
  assert.equal(value.key, "value");
});

test("isCount accepts safe non-negative integers within the max bound", () => {
  assert.equal(isCount(0), true);
  assert.equal(isCount(1), true);
  assert.equal(isCount(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isCount(10, 10), true);
  assert.equal(isCount(0, 0), true);
});

test("isCount rejects negative, fractional, unsafe, exceeding-max, and non-number values", () => {
  assert.equal(isCount(-1), false);
  assert.equal(isCount(-0.5), false);
  assert.equal(isCount(1.5), false);
  assert.equal(isCount(Number.NaN), false);
  assert.equal(isCount(Number.POSITIVE_INFINITY), false);
  assert.equal(isCount(Number.NEGATIVE_INFINITY), false);
  assert.equal(isCount(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isCount(11, 10), false);
  assert.equal(isCount("0"), false);
  assert.equal(isCount(null), false);
  assert.equal(isCount(undefined), false);
  assert.equal(isCount(0n), false);
});
