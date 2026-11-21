import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isPathWithin } from "../../src/files/path-containment.ts";

/**
 * The one owner of "this path stays beneath that root". Workspaces approvals,
 * playtest artifact stores, sandboxes, approved configurations and memory
 * capture each used to spell this check for itself.
 */
test("the root itself and its descendants are within the root", () => {
  assert.equal(isPathWithin("/a/b", "/a/b"), true);
  assert.equal(isPathWithin("/a/b", "/a/b/"), true);
  assert.equal(isPathWithin("/a/b", "/a/b/c/d.json"), true);
  assert.equal(isPathWithin("/a/b", "/a/b/..c"), true, "a child named ..c");
});

test("a sibling that shares a name prefix is not within the root", () => {
  assert.equal(isPathWithin("/a/b", "/a/bc"), false);
});

test("a path that climbs out of the root is not within it", () => {
  assert.equal(isPathWithin("/a/b", "/a"), false);
  assert.equal(isPathWithin("/a/b", "/a/b/../c"), false);
  assert.equal(isPathWithin("/a/b", "/x/y"), false);
});

test("relative paths are compared after resolution against the working directory", () => {
  assert.equal(isPathWithin("root", path.join("root", "child")), true);
  assert.equal(isPathWithin("root", path.join("root", "..", "other")), false);
});
