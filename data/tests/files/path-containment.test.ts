import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempDisposableSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isPathWithin,
  pathsOverlap,
  resolvePathWithExistingAncestor
} from "../../src/files/path-containment.ts";

/**
The one owner of "this path stays beneath that root". Workspaces approvals,
playtest artifact stores, sandboxes, approved configurations and memory
capture each used to spell this check for itself.
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

test("uncreated paths resolve physical ancestors and reject dangling redirects", () => {
  using root = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-path-ancestor-")
  );
  const base = realpathSync(root.path);
  const directory = path.join(base, "directory");
  mkdirSync(directory);
  const alias = path.join(base, "alias");
  symlinkSync(directory, alias);
  assert.equal(
    resolvePathWithExistingAncestor(path.join(alias, "future", "child")),
    path.join(directory, "future", "child")
  );
  const dangling = path.join(base, "dangling");
  symlinkSync(path.join(base, "missing"), dangling);
  assert.throws(() =>
    resolvePathWithExistingAncestor(path.join(dangling, "child"))
  );
  const file = path.join(base, "file");
  writeFileSync(file, "");
  assert.throws(() =>
    resolvePathWithExistingAncestor(path.join(file, "child"))
  );
});

test("overlap is symmetric and includes equal paths, not prefix siblings", () => {
  for (const [left, right, expected] of [
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/b/c", true],
    ["/a/b", "/a/b/..c", true],
    ["/a/b", "/a/bc", false],
    ["/a/b", "/a/b/../c", false]
  ] as const) {
    assert.equal(pathsOverlap(left, right), expected);
    assert.equal(pathsOverlap(right, left), expected);
  }
});
