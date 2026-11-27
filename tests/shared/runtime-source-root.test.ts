import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

const RUNTIME_PACKAGE_NAME = "@simulatorlife/autodev-runtime";

function withTemporaryRoot(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-source-root-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeManifest(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

test("resolveRuntimeSourceRoot uses a trimmed configured root", () => {
  withTemporaryRoot((root) => {
    assert.equal(
      resolveRuntimeSourceRoot(
        path.join(root, "src", "shared"),
        "  " + root + "  "
      ),
      path.resolve(root)
    );
  });
});

test("resolveRuntimeSourceRoot ignores a whitespace-only configured root", () => {
  withTemporaryRoot((root) => {
    assert.equal(
      resolveRuntimeSourceRoot(path.join(root, "src", "shared"), ' '.repeat(3)),
      root
    );
  });
});

test("resolveRuntimeSourceRoot recognizes a checkout by its runtime manifest", () => {
  withTemporaryRoot((root) => {
    writeManifest(
      path.join(root, "runtime", "package.json"),
      JSON.stringify({ name: RUNTIME_PACKAGE_NAME })
    );
    assert.equal(
      resolveRuntimeSourceRoot(path.join(root, "runtime", "src", "shared")),
      root
    );
  });
});

test("resolveRuntimeSourceRoot resolves an installed tree two levels up", () => {
  withTemporaryRoot((home) => {
    writeManifest(
      path.join(home, "src", "package.json"),
      JSON.stringify({ name: RUNTIME_PACKAGE_NAME })
    );
    assert.equal(
      resolveRuntimeSourceRoot(path.join(home, "src", "shared")),
      home
    );
  });
});

test("resolveRuntimeSourceRoot treats a tree without any manifest as installed", () => {
  withTemporaryRoot((home) => {
    assert.equal(
      resolveRuntimeSourceRoot(path.join(home, "a", "src", "shared")),
      path.join(home, "a")
    );
  });
});

test("resolveRuntimeSourceRoot ignores a runtime manifest naming another package", () => {
  withTemporaryRoot((root) => {
    writeManifest(
      path.join(root, "runtime", "package.json"),
      JSON.stringify({ name: "unrelated" })
    );
    assert.equal(
      resolveRuntimeSourceRoot(path.join(root, "runtime", "src", "shared")),
      path.join(root, "runtime")
    );
  });
});

test("resolveRuntimeSourceRoot ignores an unreadable runtime manifest", () => {
  withTemporaryRoot((root) => {
    writeManifest(path.join(root, "runtime", "package.json"), "{not json");
    assert.equal(
      resolveRuntimeSourceRoot(path.join(root, "runtime", "src", "shared")),
      path.join(root, "runtime")
    );
  });
});
