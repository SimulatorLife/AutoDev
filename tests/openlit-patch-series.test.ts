import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertOpenlitPatchSeries,
  OPENLIT_PATCH_NAMES
} from "./openlit-patch-series.ts";

const patchesDir = join(import.meta.dirname, "..", "patches", "openlit");

function onDisk(): string[] {
  return readdirSync(patchesDir)
    .filter((file) => file.endsWith(".patch"))
    .sort();
}

test("the maintained patch series matches the patches on disk, exactly and in order", () => {
  // The point of this file. Both series checks in
  // tests/openlit-patches-apply.test.ts need a `git clone`, so on a machine where
  // cloning the pinned OpenLIT commit is not possible -- which is every
  // developer sandbox that blocks git writes -- nothing checked the series at
  // all, and a stale or missing patch name could not be caught locally. It went
  // undetected exactly once already: the series had grown to 39 patches while a
  // second hand-maintained list in that file still stopped at 25.
  //
  // This reads the directory, so it costs nothing and runs in `test:root`.
  const files = onDisk();
  assertOpenlitPatchSeries(files);
  // The series rule intersects with what is on disk so that a checkout
  // predating the newest patches still passes, which also means it cannot see a
  // patch that is simply absent. In this repository the directory is meant to be
  // complete, so completeness is asserted here against the whole list.
  assert.deepEqual(
    files,
    Array.from(OPENLIT_PATCH_NAMES, (name) => `${name}.patch`),
    "patches/openlit must hold every maintained patch and nothing else"
  );
});

test("the series is numbered without gaps, so a patch cannot be dropped unnoticed", () => {
  const ordinals = OPENLIT_PATCH_NAMES.map((name) =>
    Number.parseInt(name.slice(0, 2))
  );
  assert.deepEqual(
    ordinals,
    Array.from({ length: OPENLIT_PATCH_NAMES.length }, (_, index) => index + 1),
    "patch ordinals must run 01..N with no gap, duplicate or reorder"
  );
});

test("a checkout that predates the newest patches still satisfies the series", () => {
  // The intersection is deliberate: the pinned-commit and apply-script tests
  // both tolerate a tree that does not yet have the newest patches, and that
  // tolerance must not be traded away while making the series exact.
  const prefix = OPENLIT_PATCH_NAMES.slice(0, 17).map(
    (name) => `${name}.patch`
  );
  assert.equal(assertOpenlitPatchSeries(prefix).length, 17);
  // ...and that tolerance is precisely why the series rule alone cannot catch a
  // patch that was simply dropped: a missing name just falls out of the
  // intersection. Completeness is the disk-vs-list assertion in the first test,
  // not this one.
  const dropped = OPENLIT_PATCH_NAMES.filter(
    (name) => name !== "38-remove-docs-and-account-surfaces"
  ).map((name) => `${name}.patch`);
  assert.equal(
    assertOpenlitPatchSeries(dropped).length,
    dropped.length,
    "the series rule is order/no-unexpected only; it tolerates an absent patch"
  );
});

test("a reordered, renamed or unexpected patch fails the series", () => {
  const full = Array.from(OPENLIT_PATCH_NAMES, (name) => `${name}.patch`);
  // Reversed rather than two entries swapped: permuting every position is the
  // stronger case, and it needs no index arithmetic to build.
  const swap = [...full].reverse();
  assert.notEqual(
    swap[0],
    full[0],
    "the reordered case must actually change the order"
  );
  const renamed = full.map((name) =>
    name === "37-remove-duplicate-agents-shell.patch"
      ? "37-remove-duplicate-agents-shell-v2.patch"
      : name
  );
  assert.equal(
    renamed.filter((name) => name.endsWith("-v2.patch")).length,
    1,
    "the renamed case must actually rename something"
  );
  const extra = [...full, "99-unexpected-patch.patch"];

  for (const [label, files] of [
    ["reordered", swap],
    ["renamed", renamed],
    ["unexpected", extra]
  ] as const) {
    assert.throws(
      () => assertOpenlitPatchSeries(files),
      /patch series must be exactly the known patches/u,
      `a ${label} series must fail`
    );
  }
});
