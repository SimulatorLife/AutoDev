import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  linkRuntimeSource,
  linkSkillSource,
  materializeRuntimeFile,
  runtimeFileMatches,
  runtimeLinkMatches,
  runtimeTarget,
  skillLinkMatches
} from "../../src/platform/runtime-files.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-runtime-files-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("runtime targets preserve relative depth for scripts and source files", () => {
  assert.equal(
    runtimeTarget("scripts/otel/run-autodev-otel-collector.sh", "/runtime"),
    "/runtime/hooks/otel/run-autodev-otel-collector.sh"
  );
  assert.equal(
    runtimeTarget("agents/prompts/base.md", "/runtime"),
    "/runtime/agents/prompts/base.md"
  );
  assert.equal(
    runtimeTarget("src/platform/runtime-files.ts", "/runtime"),
    "/runtime/src/platform/runtime-files.ts"
  );
});

test("materialization atomically replaces symlinks and applies the requested mode", () =>
  withTempDir((directory) => {
    const source = join(directory, "source.ts");
    const target = join(directory, "nested", "target.ts");
    const old = join(directory, "old.ts");
    writeFileSync(source, "new content\n");
    writeFileSync(old, "old content\n");
    mkdirSync(join(directory, "nested"));
    // A broken symlink exercises the lstat/rename path without following it.
    symlinkSync(old, target);
    materializeRuntimeFile(source, target, 0o755);
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(readFileSync(target, "utf8"), "new content\n");
    assert.equal(lstatSync(target).mode & 0o777, 0o755);
  }));

test("runtime matching is content-based and rejects symlink targets", () =>
  withTempDir((directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    writeFileSync(source, "same");
    writeFileSync(target, "same");
    assert.equal(runtimeFileMatches(source, target), true);
    writeFileSync(target, "different");
    assert.equal(runtimeFileMatches(source, target), false);
    rmSync(target);
    symlinkSync(source, target);
    assert.equal(readlinkSync(target), source);
    assert.equal(runtimeFileMatches(source, target), false);
  }));

test("runtime links replace files and validate canonical skill directories", () =>
  withTempDir((directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    writeFileSync(source, "source");
    writeFileSync(target, "old");
    linkRuntimeSource(source, target);
    assert.equal(runtimeLinkMatches(source, target), true);

    const skill = join(directory, "skill");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "# skill");
    const skillTarget = join(directory, "skills", "skill");
    linkSkillSource(skill, skillTarget);
    assert.equal(skillLinkMatches(skill, skillTarget), true);
  }));

test("runtime links replace broken symlinks idempotently and refuse non-symlink directories", () =>
  withTempDir((directory) => {
    const source = join(directory, "source");
    const target = join(directory, "target");
    writeFileSync(source, "source content");

    // Point to a nonexistent path (broken symlink)
    symlinkSync(join(directory, "nonexistent-source"), target);
    assert.equal(lstatSync(target).isSymbolicLink(), true);

    // First call should replace the broken symlink
    linkRuntimeSource(source, target);
    assert.equal(runtimeLinkMatches(source, target), true);
    assert.equal(readlinkSync(target), source);

    // Second call must be a clean idempotent no-op
    linkRuntimeSource(source, target);
    assert.equal(runtimeLinkMatches(source, target), true);

    // Non-symlink directories must fail closed to protect data
    const dirTarget = join(directory, "managed-dir");
    mkdirSync(dirTarget);
    assert.throws(
      () => linkRuntimeSource(source, dirTarget),
      /refusing to replace directory/
    );
  }));

test("materialization replaces truly broken symlinks cleanly", () =>
  withTempDir((directory) => {
    const source = join(directory, "source.ts");
    const target = join(directory, "target.ts");
    writeFileSync(source, "materialized content\n");
    symlinkSync(join(directory, "does-not-exist"), target);
    assert.equal(lstatSync(target).isSymbolicLink(), true);

    materializeRuntimeFile(source, target, 0o644);
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(readFileSync(target, "utf8"), "materialized content\n");
    assert.equal(lstatSync(target).mode & 0o777, 0o644);
  }));
