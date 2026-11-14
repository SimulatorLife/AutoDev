import assert from "node:assert/strict";
import test from "node:test";

import {
  contextHeaderValue,
  readContextHeader
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";

test("readContextHeader matches names case-insensitively and takes the first array element", () => {
  assert.equal(
    readContextHeader({ "X-AutoDev-Test": "v" }, "x-autodev-test"),
    "v"
  );
  assert.equal(
    readContextHeader({ "x-autodev-test": ["a", "b"] }, "x-autodev-test"),
    "a"
  );
  assert.equal(readContextHeader({}, "x-autodev-test"), undefined);
  assert.equal(readContextHeader(null, "x-autodev-test"), undefined);
  assert.equal(readContextHeader("nope", "x-autodev-test"), undefined);
});

test("contextHeaderValue trims strings and returns null for missing, empty, or non-string values", () => {
  const name = "x-autodev-test";
  assert.equal(
    contextHeaderValue({ "X-AutoDev-Test": "  Mixed Case  " }, name),
    "Mixed Case"
  );
  assert.equal(
    contextHeaderValue({ [name]: ["  first ", "second"] }, name),
    "first"
  );
  assert.equal(contextHeaderValue({ [name]: "   " }, name), null);
  assert.equal(contextHeaderValue({ [name]: 7 }, name), null);
  assert.equal(contextHeaderValue({ [name]: [] }, name), null);
  assert.equal(contextHeaderValue({}, name), null);
  assert.equal(contextHeaderValue(undefined, name), null);
});

test("contextHeaderValue lowercases only when asked", () => {
  const headers = { "X-AutoDev-Test": " Read-Only " };
  assert.equal(contextHeaderValue(headers, "x-autodev-test"), "Read-Only");
  assert.equal(
    contextHeaderValue(headers, "x-autodev-test", { lowercase: true }),
    "read-only"
  );
});
