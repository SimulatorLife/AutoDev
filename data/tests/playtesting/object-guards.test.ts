import assert from "node:assert/strict";
import test from "node:test";

import { isRecord } from "../../src/playtesting/object-guards.ts";

test("isRecord accepts non-null, non-array objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
});

test("isRecord rejects null, arrays, and primitives", () => {
  for (const value of [null, undefined, [], [1], "x", "", 0, 1, true, 1n]) {
    assert.equal(isRecord(value), false);
  }
});
