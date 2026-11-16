import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";

import {
  OPENCLI_PACKAGE,
  OPENCLI_VERSION,
  opencliPatchFileName,
  opencliPatchKey,
  opencliRepositoryDrift,
  opencliVersionDrift,
  parseLockfilePatchedDependencies,
  parsePatchedDependencies,
  withOpencliPatchEntry
} from "@simulatorlife/autodev-runtime/cli/opencli-version";

const root = path.resolve(import.meta.dirname, "..");

function readManifest(): string {
  return readFileSync(path.join(root, "runtime", "package.json"), "utf8");
}

function readWorkspace(): string {
  return readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
}

const FIXTURE_PATCH = "--- a/dist/index.js\n+++ b/dist/index.js\n";

/** The lockfile block pnpm writes for the pinned patch recorded as \`hash\`. */
function lockfileWithPatchHash(hash: string): string {
  return [
    "lockfileVersion: '9.0'",
    "patchedDependencies:",
    `  '${opencliPatchKey()}':`,
    `    hash: ${hash}`,
    `    path: ${opencliPatchFileName()}`,
    "importers:",
    ""
  ].join("\n");
}

function writeInstalledVersion(dir: string, version: string): void {
  const packageRoot = path.join(
    dir,
    "runtime",
    "node_modules",
    ...OPENCLI_PACKAGE.split("/")
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: OPENCLI_PACKAGE, version })
  );
}

/**
 * A repository whose every statement about opencli says the pinned version:
 * manifest, workspace patch key, patch file, lockfile and installed package.
 */
function consistentRepository(t: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "autodev-opencli-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "runtime"));
  writeFileSync(
    path.join(dir, "runtime", "package.json"),
    JSON.stringify({ dependencies: { [OPENCLI_PACKAGE]: OPENCLI_VERSION } })
  );
  writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - runtime",
      "patchedDependencies:",
      `  '${opencliPatchKey()}': ${opencliPatchFileName()}`,
      ""
    ].join("\n")
  );
  mkdirSync(path.join(dir, "patches"));
  writeFileSync(path.join(dir, opencliPatchFileName()), FIXTURE_PATCH);
  writeFileSync(
    path.join(dir, "pnpm-lock.yaml"),
    lockfileWithPatchHash(
      createHash("sha256").update(FIXTURE_PATCH).digest("hex")
    )
  );
  writeInstalledVersion(dir, OPENCLI_VERSION);
  return dir;
}

describe("the pinned opencli version", () => {
  test("the repository's manifest, patch key, patch file, lockfile and installed package agree", () => {
    assert.deepEqual(
      opencliRepositoryDrift(root),
      [],
      `the repository pins ${OPENCLI_VERSION} in ${opencliPatchKey()}, but the files disagree`
    );
  });

  test("every file the patch touches is one the installed package has", () => {
    const patch = readFileSync(path.join(root, opencliPatchFileName()), "utf8");
    const targets = Array.from(
      patch.matchAll(/^\+\+\+ b\/(.+)$/gmu),
      (match) => match[1]!
    );
    assert.ok(targets.length > 0, "the patch names no files");
    const packageRoot = path.join(
      root,
      "runtime",
      "node_modules",
      ...OPENCLI_PACKAGE.split("/")
    );
    if (!existsSync(packageRoot)) return;
    for (const target of targets)
      assert.ok(
        existsSync(path.join(packageRoot, target)),
        `the patch touches ${target}, which the installed package does not have`
      );
  });
});

describe("the repository drift check", () => {
  test("a repository that says the pinned version everywhere has no drift", (t) => {
    assert.deepEqual(opencliRepositoryDrift(consistentRepository(t)), []);
  });

  test("a repository without the patch file is drift", (t) => {
    const dir = consistentRepository(t);
    rmSync(path.join(dir, opencliPatchFileName()));
    assert.deepEqual(
      opencliRepositoryDrift(dir).map((entry) => [
        entry.file,
        entry.expected,
        entry.found
      ]),
      [[opencliPatchFileName(), "present", "missing"]]
    );
  });

  test("an installed package of another version is drift", (t) => {
    const dir = consistentRepository(t);
    writeInstalledVersion(dir, "0.0.1");
    assert.deepEqual(
      opencliRepositoryDrift(dir).map((entry) => [
        entry.file,
        entry.expected,
        entry.found
      ]),
      [[`runtime/node_modules/${OPENCLI_PACKAGE}`, OPENCLI_VERSION, "0.0.1"]]
    );
  });

  test("a lockfile that installed another patch than the repository holds is drift", (t) => {
    const dir = consistentRepository(t);
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      lockfileWithPatchHash("0".repeat(64))
    );
    const drift = opencliRepositoryDrift(dir);
    assert.equal(drift.length, 1);
    assert.equal(drift[0]?.file, "pnpm-lock.yaml");
    assert.match(drift[0]?.reason ?? "", /different patch/u);
  });
});

describe("the drift check", () => {
  test("a lockfile that installs another patch is drift", () => {
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace(),
      lockfile: lockfileWithPatchHash("0".repeat(64)),
      patchHash: "a".repeat(64)
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]?.file, "pnpm-lock.yaml");
    assert.match(drift[0]?.reason ?? "", /different patch/u);
  });

  test("the lockfile's patched dependencies are read", () => {
    const entries = parseLockfilePatchedDependencies(
      lockfileWithPatchHash("abc123")
    );
    assert.equal(entries.size, 1);
    assert.deepEqual(entries.get(opencliPatchKey()), {
      hash: "abc123",
      path: opencliPatchFileName()
    });
  });

  test("a manifest on another version is drift", () => {
    const manifest = JSON.parse(readManifest()) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies[OPENCLI_PACKAGE] = "0.0.1";
    const drift = opencliVersionDrift({
      manifest: JSON.stringify(manifest),
      workspace: readWorkspace()
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.file, "runtime/package.json");
    assert.equal(drift[0]!.found, "0.0.1");
  });

  test("a workspace that patches another version is drift", () => {
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace().replace(
        opencliPatchKey(),
        `${OPENCLI_PACKAGE}@0.0.1`
      )
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.file, "pnpm-workspace.yaml");
  });

  test("a workspace that patches no version at all is drift", () => {
    const workspace = readWorkspace()
      .split("\n")
      .filter((line) => !line.startsWith("  '@jackwener/opencli@"))
      .join("\n");
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace
    });
    assert.equal(drift.length, 1);
    assert.match(drift[0]!.reason, /patches no version/u);
  });

  test("writing the entry puts the pinned version back", () => {
    const workspace = withOpencliPatchEntry(
      readWorkspace(),
      opencliPatchKey(),
      opencliPatchFileName()
    );
    const patched = parsePatchedDependencies(workspace);
    assert.equal(patched.get(opencliPatchKey()), opencliPatchFileName());
    assert.deepEqual(
      [...patched.keys()].filter((key) => key.startsWith(OPENCLI_PACKAGE)),
      [opencliPatchKey()]
    );
  });
});
