import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  removeStalePaths,
  stalePaths
} from "@simulatorlife/autodev-runtime/platform/runtime-reconciliation";

import { withTempDir } from "../support/test-helpers.ts";

test("stale path detection uses lstat and preserves input order", () =>
  withTempDir((directory) => {
    const file = join(directory, "file");
    const link = join(directory, "link");
    const missing = join(directory, "missing");
    writeFileSync(file, "content");
    symlinkSync(join(directory, "not-present"), link);
    assert.deepEqual(stalePaths([missing, link, file]), [link, file]);
  }));

test("reconciliation removes obsolete files and symlinks without following links", () =>
  withTempDir((directory) => {
    const file = join(directory, "file");
    const link = join(directory, "link");
    const outside = join(directory, "outside");
    writeFileSync(file, "content");
    writeFileSync(outside, "keep");
    symlinkSync(outside, link);
    assert.deepEqual(removeStalePaths([file, link], "obsolete-runtime-path"), [
      file,
      link
    ]);
    assert.equal(lstatSync(file, { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  }));

test("directory reconciliation recursively removes only real directories", () =>
  withTempDir((directory) => {
    const obsolete = join(directory, "obsolete");
    const nested = join(obsolete, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "file"), "content");
    assert.deepEqual(
      removeStalePaths([obsolete], "obsolete-runtime-directory"),
      [obsolete]
    );
    assert.equal(lstatSync(obsolete, { throwIfNoEntry: false }), undefined);
  }));

test("removeStalePaths skips missing paths and preserves input order", () =>
  withTempDir((directory) => {
    const first = join(directory, "first");
    const second = join(directory, "second");
    const third = join(directory, "third");
    const fourth = join(directory, "fourth");
    const missingStart = join(directory, "missing-start");
    const missingMiddle = join(directory, "missing-middle");
    const missingEnd = join(directory, "missing-end");
    writeFileSync(first, "1");
    writeFileSync(second, "2");
    writeFileSync(third, "3");
    writeFileSync(fourth, "4");

    assert.deepEqual(
      removeStalePaths(
        [missingStart, first, missingMiddle, second, third, missingEnd, fourth],
        "obsolete-runtime-path"
      ),
      [first, second, third, fourth]
    );

    assert.equal(lstatSync(first, { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(second, { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(third, { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(fourth, { throwIfNoEntry: false }), undefined);
  }));
