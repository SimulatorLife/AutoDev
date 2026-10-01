import assert from "node:assert/strict";
import test from "node:test";

import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";

test("parseNonNegativeInteger falls back when the value is undefined", () => {
  assert.equal(parseNonNegativeInteger(undefined, 42), 42);
});

test("parseNonNegativeInteger falls back when the value is empty", () => {
  assert.equal(parseNonNegativeInteger("", 42), 42);
});

test("parseNonNegativeInteger falls back when the value is not a number", () => {
  assert.equal(parseNonNegativeInteger("not-a-number", 42), 42);
});

test("parseNonNegativeInteger falls back when the value is negative", () => {
  assert.equal(parseNonNegativeInteger("-5", 42), 42);
});

test("parseNonNegativeInteger accepts zero", () => {
  assert.equal(parseNonNegativeInteger("0", 42), 0);
});

test("parseNonNegativeInteger accepts an ordinary positive value", () => {
  assert.equal(parseNonNegativeInteger("4100", 42), 4100);
});

test("parseNonNegativeInteger accepts a parseInt-style numeric prefix", () => {
  assert.equal(parseNonNegativeInteger("4000abc", 42), 4000);
});

test("parseNonNegativeInteger truncates a fractional value", () => {
  assert.equal(parseNonNegativeInteger("10.9", 42), 10);
});
