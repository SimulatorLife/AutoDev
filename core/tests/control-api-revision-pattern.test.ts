import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_API_REVISION_PATTERN } from "../src/control-api/types.ts";

/**
The revision a Control API compare-and-swap is decided on.

The Runtime and the Console both read a revision out of a request and
compare it with the one the canonical file is at. They have to agree on
what a revision looks like, so the shape lives in Core once and both sides
read it from there: a sha256 digest, lowercase, exactly 64 characters.
*/
test("a revision is a lowercase sha256 digest", () => {
  assert.equal(CONTROL_API_REVISION_PATTERN.test("a".repeat(64)), true);
  assert.equal(
    CONTROL_API_REVISION_PATTERN.test("0123456789abcdef".repeat(4)),
    true
  );
});

test("a revision is not anything else that looks like a digest", () => {
  assert.equal(
    CONTROL_API_REVISION_PATTERN.test("A".repeat(64)),
    false,
    "the Runtime computes lowercase digests; an uppercase one is not the digest it read"
  );
  assert.equal(CONTROL_API_REVISION_PATTERN.test("a".repeat(63)), false);
  assert.equal(CONTROL_API_REVISION_PATTERN.test("a".repeat(65)), false);
  assert.equal(CONTROL_API_REVISION_PATTERN.test(""), false);
  assert.equal(
    CONTROL_API_REVISION_PATTERN.test("g".repeat(64)),
    false,
    "a digest is hexadecimal"
  );
});
