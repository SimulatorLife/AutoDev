import assert from "node:assert/strict";
import test from "node:test";

import {
  isHardLimitClass,
  isTransientFailureClass,
  PROVIDER_HARD_LIMIT_CLASSES,
  PROVIDER_TRANSIENT_FAILURE_CLASSES
} from "../src/index.ts";

test("PROVIDER_HARD_LIMIT_CLASSES classifies quota_exhausted and session_limit", () => {
  assert.deepEqual(
    [...PROVIDER_HARD_LIMIT_CLASSES],
    ["quota_exhausted", "session_limit"]
  );
  assert.equal(isHardLimitClass("quota_exhausted"), true);
  assert.equal(isHardLimitClass("session_limit"), true);
  assert.equal(isHardLimitClass("throttled"), false);
  assert.equal(isHardLimitClass("timeout"), false);
  assert.equal(isHardLimitClass(""), false);
  assert.equal(isHardLimitClass(null), false);
  assert.equal(isHardLimitClass(undefined), false);
});

test("PROVIDER_TRANSIENT_FAILURE_CLASSES identifies condition-based failures that expire after cooldown", () => {
  for (const failureClass of PROVIDER_TRANSIENT_FAILURE_CLASSES) {
    assert.equal(isTransientFailureClass(failureClass), true);
  }
  // Hard limits are also conditions that pass once the window resets
  assert.equal(isTransientFailureClass("quota_exhausted"), true);
  assert.equal(isTransientFailureClass("session_limit"), true);
  // Refusals and credentials are permanent / configuration errors
  assert.equal(isTransientFailureClass("authentication"), false);
  assert.equal(isTransientFailureClass("invalid_model"), false);
  assert.equal(isTransientFailureClass("unsupported_request"), false);
  assert.equal(isTransientFailureClass("request_error"), false);
  assert.equal(isTransientFailureClass(null), false);
  assert.equal(isTransientFailureClass(undefined), false);
});
