import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  atomicWrite,
  AtomicWriteDirectoryError,
  atomicWriteSync
} from "../../src/files/atomic-write.ts";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "autodev-atomic-write-"));
}

test("atomicWriteSync creates parents and applies the requested mode", () => {
  const file = path.join(scratch(), "a", "b", "out.txt");
  atomicWriteSync(file, "hello\n", { mode: 0o600 });
  assert.equal(readFileSync(file, "utf8"), "hello\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(file)), ["out.txt"]);
});

test("an explicit mode replaces the old mode and an omitted mode keeps it", () => {
  const file = path.join(scratch(), "out.txt");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  atomicWriteSync(file, "kept");
  assert.equal(statSync(file).mode & 0o777, 0o640);
  atomicWriteSync(file, "changed", { mode: 0o600 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("skipUnchanged leaves a file with the same content and mode alone", async () => {
  const file = path.join(scratch(), "out.txt");
  atomicWriteSync(file, "same", { mode: 0o600, skipUnchanged: true });
  const past = new Date(1_000_000);
  utimesSync(file, past, past);
  atomicWriteSync(file, "same", { mode: 0o600, skipUnchanged: true });
  await atomicWrite(file, "same", { mode: 0o600, skipUnchanged: true });
  assert.equal(statSync(file).mtimeMs, past.getTime());
  atomicWriteSync(file, "same", { mode: 0o644, skipUnchanged: true });
  assert.equal(statSync(file).mode & 0o777, 0o644);
});

test("a directory at the target is refused and left intact", async () => {
  const directory = path.join(scratch(), "target");
  mkdirSync(directory);
  assert.throws(
    () => atomicWriteSync(directory, "x"),
    AtomicWriteDirectoryError
  );
  await assert.rejects(atomicWrite(directory, "x"), AtomicWriteDirectoryError);
  assert.deepEqual(readdirSync(directory), []);
});

test("a failed write leaves no temporary file behind", async () => {
  const directory = scratch();
  const blocked = path.join(directory, "blocked");
  writeFileSync(blocked, "a file, not a directory");
  const file = path.join(blocked, "out.txt");
  assert.throws(() => atomicWriteSync(file, "x"));
  await assert.rejects(atomicWrite(file, "x"));
  assert.deepEqual(readdirSync(directory), ["blocked"]);
});

test("concurrent async writers leave one complete value and no temporary files", async () => {
  const directory = scratch();
  const file = path.join(directory, "state.json");
  const values = Array.from({ length: 24 }, (_, index) =>
    JSON.stringify({ writer: index, padding: "x".repeat(50_000) })
  );
  await Promise.all(values.map((value) => atomicWrite(file, value)));
  assert.ok(values.includes(readFileSync(file, "utf8")));
  assert.deepEqual(readdirSync(directory), ["state.json"]);
});

test("concurrent writer processes never corrupt the file", async () => {
  const directory = scratch();
  const file = path.join(directory, "state.json");
  const helper = path.resolve("src/files/atomic-write.ts");
  const script = path.join(directory, "writer.ts");
  writeFileSync(
    script,
    `import { atomicWriteSync } from ${JSON.stringify(helper)};
for (let index = 0; index < 20; index += 1)
  atomicWriteSync(process.argv[2]!, JSON.stringify({ writer: process.argv[3], index, padding: "y".repeat(20000) }));`
  );
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      promisify(execFile)(process.execPath, [script, file, String(index)])
    )
  );
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { index: number };
  assert.equal(parsed.index, 19);
  assert.deepEqual(readdirSync(directory).sort(), ["state.json", "writer.ts"]);
});
