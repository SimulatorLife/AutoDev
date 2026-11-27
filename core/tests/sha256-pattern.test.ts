import assert from "node:assert/strict";
import test from "node:test";

import { SHA256_PATTERN } from "../src/shared/sha256.ts";

/**
The one owner of "this string is a sha256 digest".

The Runtime, the Data layer and the Console all read digests out of the
artifacts they exchange, and each side used to spell the shape of a digest
for itself. These tests hold the single owner to that shape: a hex digest
of exactly 64 characters, in either case.
*/
test("a sha256 digest is 64 hex characters", () => {
  assert.equal(SHA256_PATTERN.test("a".repeat(64)), true);
  assert.equal(SHA256_PATTERN.test("0123456789abcdef".repeat(4)), true);
});

test("a digest is accepted in either case", () => {
  assert.equal(
    SHA256_PATTERN.test("A".repeat(64)),
    true,
    "an uppercase digest names the same bytes as a lowercase one"
  );
});

test("anything that is not a digest is refused", () => {
  assert.equal(SHA256_PATTERN.test(""), false);
  assert.equal(SHA256_PATTERN.test("a".repeat(63)), false);
  assert.equal(SHA256_PATTERN.test("a".repeat(65)), false);
  assert.equal(
    SHA256_PATTERN.test("g".repeat(64)),
    false,
    "a digest is hexadecimal"
  );
  assert.equal(SHA256_PATTERN.test("a".repeat(63) + "!"), false);
});
