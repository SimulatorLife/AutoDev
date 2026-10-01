import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executableArch,
  hostArch,
  resolveServiceNode,
  runsNatively
} from "../../src/platform/host-arch.ts";
import { executableHeader } from "./executable-header.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-host-arch-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeExecutable(
  directory: string,
  name: string,
  header: Buffer
): string {
  const file = join(directory, name);
  writeFileSync(file, header);
  chmodSync(file, 0o755);
  return file;
}

test("a Rosetta process on Apple Silicon still reports the machine as arm64", () => {
  assert.equal(
    hostArch("darwin", "x64", () => true),
    "arm64",
    "process.arch is x64 under Rosetta; choosing binaries by it picks Intel builds"
  );
  assert.equal(
    hostArch("darwin", "x64", () => false),
    "amd64"
  );
  assert.equal(
    hostArch("linux", "arm64", () => false),
    "arm64"
  );
  assert.equal(
    hostArch("linux", "x64", () => false),
    "amd64"
  );
  assert.throws(() => hostArch("linux", "ia32", () => false), /unsupported/);
});

test("executable architecture is read from the Mach-O or ELF header", () =>
  withTempDir((directory) => {
    for (const [arch, expected] of [
      ["arm64", "arm64"],
      ["amd64", "amd64"],
      ["universal", "universal"],
      ["elf-arm64", "arm64"],
      ["elf-amd64", "amd64"]
    ] as const)
      assert.equal(
        executableArch(
          writeExecutable(directory, arch, executableHeader(arch))
        ),
        expected,
        arch
      );
    assert.equal(
      executableArch(
        writeExecutable(directory, "script", Buffer.from("#!/bin/sh\n"))
      ),
      null
    );
    assert.equal(executableArch(join(directory, "missing")), null);
  }));

test("a universal binary runs natively on either architecture", () =>
  withTempDir((directory) => {
    const universal = writeExecutable(
      directory,
      "universal",
      executableHeader("universal")
    );
    assert.equal(runsNatively(universal, "arm64"), true);
    assert.equal(runsNatively(universal, "amd64"), true);
    const intel = writeExecutable(
      directory,
      "intel",
      executableHeader("amd64")
    );
    assert.equal(runsNatively(intel, "arm64"), false);
  }));

test("services run on the first native Node, not the first one on PATH", () =>
  withTempDir((directory) => {
    const intel = writeExecutable(
      directory,
      "intel-node",
      executableHeader("amd64")
    );
    const native = writeExecutable(
      directory,
      "native-node",
      executableHeader("arm64")
    );
    assert.equal(
      resolveServiceNode(directory, "arm64", [intel, null, native]),
      native
    );
    assert.equal(
      resolveServiceNode(directory, "arm64", [join(directory, "gone"), intel]),
      intel,
      "with no native Node, a usable one still beats none"
    );
  }));
